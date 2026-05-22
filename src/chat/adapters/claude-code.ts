/**
 * ClaudeCodeAdapter — wraps the user's claude CLI via the Rust
 * engines::claude_code module. The "ACP" naming is internal: the events
 * crossing the Tauri boundary are still ACP-shaped (SessionUpdate /
 * RequestPermissionRequest), but the adapter is presented to the chat
 * surface as just one of N engines. Phase 1 of the multi-engine rebuild.
 *
 * Implements the existing `ChatAdapter` interface so the UI doesn't need to
 * know it's talking to the new ACP path. Under the hood it delegates to the
 * `AcpEngine` from `@/lib/engine` (which itself wraps the Rust ACP server's
 * Tauri commands).
 *
 * Translation:
 *   - `attach()` subscribes to `chat://session/{threadId}` and translates the
 *     ACP `SessionUpdate` events into the legacy `ChatEvent` shape the store
 *     already consumes. This keeps the Thread / ToolCallCard renderers
 *     untouched.
 *   - `send()` ships text through `chatPrompt`. Images are still routed via
 *     the composer's direct `chatPrompt` call (Phase 7 path) — text-only is
 *     the adapter's contract today.
 *   - `cancel()` calls `chatCancel` (clean interrupt, not kill-the-child).
 *
 * Feature flag: the registry selects this adapter when
 * `localStorage.ikenga_chat_engine === 'acp'` (the Phase-10 default), or the
 * legacy `ClaudeCliAdapter` otherwise.
 *
 * TODO(phase-11): once the legacy adapter is retired we can collapse the
 * `ChatEvent` translation away and have the store consume `AcpSessionUpdate`
 * directly.
 */

import { Sparkles } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
	chatCancel,
	chatListen,
	chatNewSession,
	chatPrompt,
	claudeListSessions,
	type AcpContentBlock,
	type AcpSessionNotification,
	type AcpSessionUpdate,
	type ChatEvent,
} from '@/lib/tauri-cmd';
import { activeProjectCwd } from '@/lib/shell/active-project-cwd';

import { useChatStore } from '../store';
import { updateThreadMeta } from '../persist';
import type {
	AdapterCapabilities,
	AdapterContext,
	ChatAdapter,
	ChatInput,
	ChatThread,
	ModelOption,
} from '../adapter';

const CAPABILITIES: AdapterCapabilities = {
	toolCalls: true,
	artifacts: true,
	fileAttachments: true,
	// Phase 7 wired end-to-end image support through the ACP path.
	imageInput: true,
	slashCommands: true,
	// ADR-011 phase 3: model + effort are session-level on the ACP adapter.
	// The Composer exposes them as pills; changes mutate Rust-side SessionOpts
	// via `chatSetModel` / `chatSetEffort` and take effect on next spawn.
	modelSwitching: true,
	effortControl: true,
	streaming: true,
	promptCaching: true,
	agenticTools: true,
};

/** ADR-011 phase 3: canonical Claude Code model options exposed in the
 *  Model pill. Ids match what claude CLI accepts via `--model`. */
const ACP_MODELS: ModelOption[] = [
	{ id: 'claude-opus-4-7', label: 'Opus 4.7' },
	{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
	{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

interface ActiveStream {
	threadId: string;
	unlisten: UnlistenFn | null;
}

/**
 * Map a single ACP `SessionUpdate` to a legacy `ChatEvent`. Returns null for
 * variants that have no direct store representation (e.g. `current_mode_update`
 * — the composer mode picker mirrors its own state).
 *
 * The store's existing reducers don't change shape between ACP and legacy
 * — they just need ChatEvents. We translate at the adapter boundary so the
 * rest of the chat code stays single-shape.
 */
// The `AcpSessionUpdate` union is open-ended at its tail (string indexed)
// so TS can't narrow `update.content` past `unknown`. We treat each variant
// as a known shape and assert into a local type — this is safe because the
// Rust side guarantees the schema per `sessionUpdate` discriminator.
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
			// Only emit a tool_result row when the call has actually finished.
			// Earlier "in_progress" updates have no equivalent in the legacy shape.
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

class ClaudeCodeAdapterImpl implements ChatAdapter {
	readonly id = 'claude-code';
	readonly label = 'Claude Code';
	readonly Icon = Sparkles;
	readonly models: ModelOption[] | null = ACP_MODELS;
	readonly capabilities = CAPABILITIES;

	/** One subscription per thread. Keyed by threadId so re-mounts don't
	 *  double-subscribe (and so `destroy()` can tear them all down). */
	private streams = new Map<string, ActiveStream>();
	/** Set of threadIds whose Rust-side ACP session has been created. We do
	 *  this lazily on first attach so opening an existing thread doesn't pay
	 *  the new-session round-trip if it's already known to the Rust side. */
	private sessioned = new Set<string>();

	async init(_ctx: AdapterContext): Promise<void> {
		// No API key needed — the underlying Rust ACP server wraps the user's
		// already-authenticated `claude` binary.
	}

	/** Ensure the ACP session row exists and a subscription is attached.
	 *  Idempotent; safe to call from a hook on every mount. */
	async attach(threadId: string, cwd: string, projectId?: string | null): Promise<void> {
		if (this.streams.has(threadId)) return;
		// Claim the slot SYNCHRONOUSLY, before any await. `attach` is called
		// concurrently from a thread's mount hook and from `send()`; the seeded-
		// chat path fires both near-simultaneously. If we awaited `chatNewSession`
		// before recording the entry, both callers would pass the `.has` guard
		// above and each subscribe via `chatListen`, leaving two live listeners on
		// `chat://session/{threadId}`. Every SessionUpdate would then be delivered
		// twice — doubled assistant text (coalesced into one bubble) and duplicate
		// tool-call cards. The placeholder closes that window: a concurrent caller
		// sees it and bails.
		const placeholder: ActiveStream = { threadId, unlisten: null };
		this.streams.set(threadId, placeholder);
		try {
			if (!this.sessioned.has(threadId)) {
				// `acp_new_session` is idempotent on the Rust side via the threadId
				// key: it returns the existing modes state if the thread already
				// exists. The child stays lazy — spawn happens on the first prompt.
				// Phase 3 (projects-first-class): thread the active project's id via
				// `_meta.projectId` so the Rust side can resolve the cwd to the
				// project's root_path when the caller's cwd is empty/wrong.
				try {
					const meta: Record<string, unknown> = { threadId };
					if (projectId) meta.projectId = projectId;
					await chatNewSession({ cwd, mcpServers: [], _meta: meta }, 'claude-code');
					this.sessioned.add(threadId);
				} catch (e) {
					// If the Rust side decides the thread already has a different cwd
					// and rejects, fall through to listening — the existing session
					// remains valid.
					console.warn('chatNewSession:', e);
				}
			}
			const unlisten = await chatListen(
				threadId,
				(notif) => this.onNotification(threadId, notif),
				'claude-code'
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
		if (!existing) return; // store row not hydrated yet — drop on the floor

		// Phase 5: the ACP server emits the underlying claude session id via the
		// `_meta` envelope on the first prompt response, but we also capture it
		// from any session_init that surfaces. The legacy adapter pulls it from
		// a `session_init` ChatEvent; ACP doesn't translate that 1:1, so we
		// peek into _meta when present.
		const claudeSessionId = (notif._meta as { claudeSessionId?: string } | undefined)
			?.claudeSessionId;
		if (claudeSessionId && existing.thread.claudeSessionId !== claudeSessionId) {
			store.setThread(threadId, { claudeSessionId });
			void updateThreadMeta(threadId, { claudeSessionId });
		}

		const event = acpUpdateToChatEvent(notif.update);
		if (!event) return;
		if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use') {
			if (existing.status !== 'streaming') store.setStatus(threadId, 'streaming');
		}
		store.appendEvents(threadId, [event]);
	}

	send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
		const streamId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
				const res = await chatPrompt({ sessionId: input.threadId, prompt }, 'claude-code');
				// chatPrompt resolves when the turn ends. Clear streaming status.
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
		// Per-turn streamId isn't meaningful for ACP — cancellation is
		// per-session. Find the active thread via the store, then write a
		// clean interrupt to the underlying claude child via `chatCancel`.
		const state = useChatStore.getState();
		const active = Object.values(state.threads).find((t) => t.streamId === _streamId);
		const tid = active?.thread.id;
		if (!tid) return;
		try {
			await chatCancel(tid, 'claude-code');
		} catch (e) {
			console.warn('chatCancel:', e);
		}
		state.appendEvents(tid, [{ kind: 'system_hook', hookEvent: 'cancel', name: 'user_cancel' }]);
		state.setStatus(tid, 'interrupted');
	}

	async suspend(): Promise<void> {
		// No-op; the ACP server keeps the child alive between turns by design.
	}

	async migrate(_thread: ChatThread): Promise<void> {
		throw new Error('ClaudeCodeAdapter.migrate: not implemented');
	}

	async listSessions() {
		// Same on-disk JSONL surface — `claudeListSessions` reads the user's
		// `~/.claude/projects/<hash>/*.jsonl` files regardless of how the
		// session was driven (legacy CLI or ACP).
		return claudeListSessions(null);
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

export const ClaudeCodeAdapter: ChatAdapter = new ClaudeCodeAdapterImpl();

/** Test helper. */
export function getClaudeCodeAdapterInstance(): ClaudeCodeAdapterImpl {
	return ClaudeCodeAdapter as unknown as ClaudeCodeAdapterImpl;
}
