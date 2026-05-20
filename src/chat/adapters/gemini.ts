/**
 * GeminiAdapter — drives the Rust `engines::gemini_acp` engine, which
 * spawns `gemini --experimental-acp` as a child process and shuttles
 * JSON-RPC over its stdio. Phase 2 of the multi-engine rebuild.
 *
 * The wire shape is identical to Claude — the Rust side emits
 * `AcpSessionNotification` envelopes on `chat://session/{threadId}` and
 * permission requests on `chat://session/{threadId}/request`. Translation
 * logic in `acpUpdateToChatEvent` is the same per-variant code as the
 * Claude adapter; we keep them in separate files so each engine's
 * adapter can diverge on capability and copy without surgery on the
 * shared file.
 *
 * Capabilities mirror `CAP_GEMINI` from `src-tauri/src/agent_detect/known.rs`:
 *   - streaming + tool use + image input ✓
 *   - extended thinking + per-session effort ✗
 *   - model switching: deferred (Composer hides the pill via
 *     `capabilities.modelSwitching = false`)
 *
 * Auth: the user must have `GEMINI_API_KEY` set or a credentials file at
 * `~/.config/gemini/credentials.json`. If neither exists, the child
 * still spawns and Gemini surfaces a typed error on the first prompt —
 * the FE renders it as an error toast via the standard error path.
 */

import { Sparkle } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
	chatCancel,
	chatListen,
	chatNewSession,
	chatPrompt,
	type AcpContentBlock,
	type AcpSessionNotification,
	type AcpSessionUpdate,
	type ChatEvent,
} from '@/lib/tauri-cmd';
import { activeProjectCwd } from '@/lib/shell/active-project-cwd';

import { useChatStore } from '../store';
import type {
	AdapterCapabilities,
	AdapterContext,
	ChatAdapter,
	ChatInput,
	ChatThread,
	ModelOption,
} from '../adapter';

/** Engine id the Rust dispatcher recognises. Threaded through every
 *  Tauri call so the registry routes to `engines::gemini_acp`. */
const ENGINE_ID = 'gemini' as const;

const CAPABILITIES: AdapterCapabilities = {
	toolCalls: true,
	artifacts: false,
	fileAttachments: true,
	imageInput: true,
	slashCommands: false,
	// CAP_GEMINI sets thinking + effortControl false; modelSwitching is
	// deferred to a future phase that wires per-prompt model overrides.
	modelSwitching: false,
	effortControl: false,
	streaming: true,
	promptCaching: false,
	agenticTools: true,
};

const GEMINI_MODELS: ModelOption[] = [
	{ id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro' },
	{ id: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash' },
];

interface ActiveStream {
	threadId: string;
	unlisten: UnlistenFn | null;
}

// SessionUpdate variants we care about. The wire shape is identical to
// Claude's — Gemini emits the same ACP-shaped envelopes. Duplicated from
// claude-code.ts to keep the per-adapter file self-contained; if a
// third+ engine joins we'll lift this into a shared helper.
interface AcpChunkUpdate {
	sessionUpdate: string;
	content?: { type: string; text?: string };
	messageId?: string;
}
interface AcpToolCallUpdateWire {
	sessionUpdate: 'tool_call';
	toolCallId: string;
	title: string;
	rawInput?: unknown;
}
interface AcpToolCallUpdateUpdateWire {
	sessionUpdate: 'tool_call_update';
	toolCallId: string;
	fields?: {
		status?: string;
		content?: unknown[];
		rawOutput?: unknown;
	};
}

function acpUpdateToChatEvent(update: AcpSessionUpdate): ChatEvent | null {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk': {
			const u = update as AcpChunkUpdate;
			const c = u.content;
			if (c && c.type === 'text' && typeof c.text === 'string') {
				return { kind: 'text', delta: c.text, messageId: u.messageId };
			}
			return null;
		}
		case 'agent_thought_chunk': {
			const u = update as AcpChunkUpdate;
			const c = u.content;
			if (c && c.type === 'text' && typeof c.text === 'string') {
				return { kind: 'thinking', delta: c.text, messageId: u.messageId };
			}
			return null;
		}
		case 'tool_call': {
			const u = update as AcpToolCallUpdateWire;
			return {
				kind: 'tool_use',
				id: u.toolCallId,
				name: u.title,
				input: u.rawInput,
			};
		}
		case 'tool_call_update': {
			const u = update as AcpToolCallUpdateUpdateWire;
			const status = u.fields?.status;
			if (status === 'completed' || status === 'failed') {
				return {
					kind: 'tool_result',
					id: u.toolCallId,
					output: u.fields?.rawOutput ?? u.fields?.content,
					isError: status === 'failed',
				};
			}
			return null;
		}
		case 'user_message_chunk':
		case 'current_mode_update':
		case 'plan_update':
			return null;
		default:
			return null;
	}
}

class GeminiAdapterImpl implements ChatAdapter {
	readonly id = 'gemini';
	readonly label = 'Gemini';
	readonly Icon = Sparkle;
	readonly models: ModelOption[] | null = GEMINI_MODELS;
	readonly capabilities = CAPABILITIES;

	private streams = new Map<string, ActiveStream>();
	private sessioned = new Set<string>();

	async init(_ctx: AdapterContext): Promise<void> {
		// No FE-side init — the Rust engine handles auth via the user's
		// GEMINI_API_KEY / credentials.json. We don't pre-flight check
		// auth (the brief says "if not, the child spawns and the user
		// gets a typed error back through the prompt response").
	}

	async attach(threadId: string, cwd: string, projectId?: string | null): Promise<void> {
		if (this.streams.has(threadId)) return;
		if (!this.sessioned.has(threadId)) {
			try {
				const meta: Record<string, unknown> = { threadId };
				if (projectId) meta.projectId = projectId;
				await chatNewSession({ cwd, mcpServers: [], _meta: meta }, ENGINE_ID);
				this.sessioned.add(threadId);
			} catch (e) {
				// Same forgiving semantics as Claude — log and continue.
				console.warn('chatNewSession (gemini):', e);
			}
		}
		const placeholder: ActiveStream = { threadId, unlisten: null };
		this.streams.set(threadId, placeholder);
		try {
			const unlisten = await chatListen(
				threadId,
				(notif) => this.onNotification(threadId, notif),
				ENGINE_ID,
			);
			placeholder.unlisten = unlisten;
		} catch (e) {
			this.streams.delete(threadId);
			throw e;
		}
	}

	private onNotification(threadId: string, notif: AcpSessionNotification) {
		const store = useChatStore.getState();
		const existing = store.threads[threadId];
		if (!existing) return;
		const event = acpUpdateToChatEvent(notif.update);
		if (!event) return;
		if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use') {
			if (existing.status !== 'streaming') store.setStatus(threadId, 'streaming');
		}
		store.appendEvents(threadId, [event]);
	}

	send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
		const streamId = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		let resolveNext: ((v: IteratorResult<ChatEvent>) => void) | null = null;
		let closed = false;

		const close = () => {
			closed = true;
			resolveNext?.({ value: undefined as unknown as ChatEvent, done: true });
			resolveNext = null;
		};

		void (async () => {
			try {
				const cwd = useChatStore.getState().threads[input.threadId]?.thread.cwd || '';
				await this.attach(input.threadId, cwd || activeProjectCwd());
				useChatStore.getState().setStatus(input.threadId, 'streaming');

				const prompt: AcpContentBlock[] = [{ type: 'text', text: input.text }];
				const res = await chatPrompt({ sessionId: input.threadId, prompt }, ENGINE_ID);
				useChatStore
					.getState()
					.setStatus(input.threadId, res.stopReason === 'cancelled' ? 'interrupted' : 'idle');
			} catch (e) {
				useChatStore
					.getState()
					.setStatus(input.threadId, 'error', e instanceof Error ? e.message : String(e));
			} finally {
				close();
			}
		})();

		const iterable: AsyncIterable<ChatEvent> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						if (closed) {
							return Promise.resolve({
								value: undefined as unknown as ChatEvent,
								done: true,
							});
						}
						return new Promise<IteratorResult<ChatEvent>>((resolve) => {
							resolveNext = resolve;
						});
					},
				};
			},
		};

		return { streamId, iterable };
	}

	async cancel(_streamId: string): Promise<void> {
		const state = useChatStore.getState();
		const active = Object.values(state.threads).find((t) => t.streamId === _streamId);
		const tid = active?.thread.id;
		if (!tid) return;
		try {
			await chatCancel(tid, ENGINE_ID);
		} catch (e) {
			console.warn('chatCancel (gemini):', e);
		}
		state.appendEvents(tid, [{ kind: 'system_hook', hookEvent: 'cancel', name: 'user_cancel' }]);
		state.setStatus(tid, 'interrupted');
	}

	async suspend(): Promise<void> {
		// No-op; Gemini's child stays alive between turns by design.
	}

	async migrate(_thread: ChatThread): Promise<void> {
		throw new Error('GeminiAdapter.migrate: not implemented');
	}

	async listSessions() {
		// Gemini doesn't store sessions on disk the way Claude does;
		// return an empty list for now. Future phase will surface
		// gemini's session history through a dedicated command.
		return [];
	}

	async destroy(): Promise<void> {
		const entries = [...this.streams.values()];
		this.streams.clear();
		this.sessioned.clear();
		for (const s of entries) {
			s.unlisten?.();
		}
	}
}

export const GeminiAdapter: ChatAdapter = new GeminiAdapterImpl();

/** Test helper. */
export function getGeminiAdapterInstance(): GeminiAdapterImpl {
	return GeminiAdapter as unknown as GeminiAdapterImpl;
}
