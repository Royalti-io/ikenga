/**
 * CodexAdapter — wraps the OpenAI Codex CLI via the Rust
 * `engines::codex_pty` module. Phase 3 of the multi-engine rebuild.
 *
 * Coarse-but-real: codex runs as a full-screen TUI, so we PTY-spawn the
 * `codex` binary, strip ANSI from its byte stream, drop box-drawing
 * chrome, and emit each surviving content line as a single text chunk on
 * the chat channel. No tool-call extraction, no thinking blocks, no
 * permission round-trips, no model picker — the Rust capabilities
 * advertised by this adapter mirror `agent_detect::known::CAP_CODEX`
 * exactly (streaming only).
 *
 * When/if we replace the PTY-wrap with the Zed
 * `@zed-industries/codex-acp` adapter, this file restores tool calls /
 * model switching / etc. via the same `ChatAdapter` surface.
 *
 * Integration status: this file mirrors `claude-code.ts` but the engine
 * dispatch in `commands/chat.rs` is being refactored to take an
 * `engineId` by a parallel agent this session. We pass through
 * `_meta.engineId = 'codex'` so once the Rust side accepts that
 * discriminator, this adapter routes to the codex engine without further
 * client changes.
 */

// TODO(phase-3-integration): register CodexAdapter in src/chat/index.ts
// once the parallel agent's adapter-registration refactor lands. Until
// then this adapter is reachable only via direct import.

import { Terminal } from 'lucide-react';
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

/** Capabilities advertised by the PTY-wrapped codex engine. Mirrors the
 *  Rust `CAP_CODEX` constant: streaming only. */
const CAPABILITIES: AdapterCapabilities = {
	toolCalls: false,
	artifacts: false,
	fileAttachments: false,
	imageInput: false,
	slashCommands: false,
	modelSwitching: false,
	effortControl: false,
	streaming: true,
	promptCaching: false,
	agenticTools: false,
};

interface ActiveStream {
	threadId: string;
	unlisten: UnlistenFn | null;
}

/** The Rust codex engine only emits `agent_message_chunk` text updates,
 *  but we share the `AcpSessionUpdate` translation shape with the Claude
 *  adapter for forward-compat. Any unknown discriminator becomes a no-op. */
interface CodexChunkUpdate {
	sessionUpdate: string;
	content?: { type: string; text?: string };
	messageId?: string;
}

function codexUpdateToChatEvent(update: AcpSessionUpdate): ChatEvent | null {
	if (update.sessionUpdate === 'agent_message_chunk') {
		const u = update as CodexChunkUpdate;
		const c = u.content;
		if (c && c.type === 'text' && typeof c.text === 'string') {
			return { kind: 'text', delta: c.text, messageId: u.messageId };
		}
	}
	return null;
}

class CodexAdapterImpl implements ChatAdapter {
	readonly id = 'codex';
	readonly label = 'Codex (preview)';
	readonly Icon = Terminal;
	/** Codex's model picker is owned by the codex CLI itself; we don't
	 *  surface a per-session override through this adapter. */
	readonly models: ModelOption[] | null = null;
	readonly capabilities = CAPABILITIES;

	private streams = new Map<string, ActiveStream>();
	private sessioned = new Set<string>();

	async init(_ctx: AdapterContext): Promise<void> {
		// No API key needed at the adapter layer — the codex CLI handles
		// its own auth (env vars / OAuth token cached on disk).
	}

	async attach(threadId: string, cwd: string, projectId?: string | null): Promise<void> {
		if (this.streams.has(threadId)) return;
		if (!this.sessioned.has(threadId)) {
			try {
				const meta: Record<string, unknown> = {
					threadId,
					// TODO(phase-3-integration): the parallel agent's refactor
					// adds an `engineId` field to `chatNewSession`. Until that
					// lands we route via `_meta.engineId` so the Rust dispatch
					// can pick up the discriminator without a schema change.
					engineId: 'codex',
				};
				if (projectId) meta.projectId = projectId;
				await chatNewSession({ cwd, mcpServers: [], _meta: meta });
				this.sessioned.add(threadId);
			} catch (e) {
				console.warn('codex chatNewSession:', e);
			}
		}
		const placeholder: ActiveStream = { threadId, unlisten: null };
		this.streams.set(threadId, placeholder);
		try {
			const unlisten = await chatListen(threadId, (notif) => this.onNotification(threadId, notif));
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

		const event = codexUpdateToChatEvent(notif.update);
		if (!event) return;
		if (event.kind === 'text') {
			if (existing.status !== 'streaming') store.setStatus(threadId, 'streaming');
		}
		store.appendEvents(threadId, [event]);
	}

	send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
		const streamId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

				// Codex's PTY interface has no concept of image content blocks
				// — collapse the input down to plain text. Attachments are
				// silently dropped (could mention them in the prompt body in a
				// future pass if useful).
				const prompt: AcpContentBlock[] = [{ type: 'text', text: input.text }];
				const res = await chatPrompt({ sessionId: input.threadId, prompt });
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
			// Rust side sends a Ctrl-C (ETX) to the codex PTY's foreground
			// process group. Best-effort — codex may or may not honor it
			// depending on what it's doing mid-turn.
			await chatCancel(tid);
		} catch (e) {
			console.warn('codex chatCancel:', e);
		}
		state.appendEvents(tid, [{ kind: 'system_hook', hookEvent: 'cancel', name: 'user_cancel' }]);
		state.setStatus(tid, 'interrupted');
	}

	async suspend(): Promise<void> {
		// No-op; the PTY engine keeps the codex child alive between turns.
	}

	async migrate(_thread: ChatThread): Promise<void> {
		throw new Error('CodexAdapter.migrate: not implemented');
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

export const CodexAdapter: ChatAdapter = new CodexAdapterImpl();

/** Test helper. */
export function getCodexAdapterInstance(): CodexAdapterImpl {
	return CodexAdapter as unknown as CodexAdapterImpl;
}
