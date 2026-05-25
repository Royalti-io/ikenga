/**
 * Chat hooks — the only API surface the route page / pane chat-view should
 * use. Coordinates registry + store + persist.
 *
 * v2: threadId is stable across the placeholder→real transition; the route
 * does not remount. The adapter is the canonical writer to the store; the
 * hook only hydrates from SQLite + JSONL and runs a periodic reconciler so
 * disk-flushed events aren't lost if a live subscription is dropped.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProjectCwd } from '@/lib/shell/active-project-cwd';
import { useShellStore } from '@/lib/shell/shell-store';
import { type ChatEvent, claudeReadJsonl } from '@/lib/tauri-cmd';
import { defaultChatAdapterId } from './default-adapter';
import {
	appendMessage,
	appendUserTurn,
	clearLivePtys,
	createThread,
	findThreadById,
	loadMessages,
	loadUserTurns,
	type PersistedMessage,
	pruneOldMessages,
	updateThreadMeta,
} from './persist';
import { getAdapter } from './registry';
import { eventSignature, type ThreadState, useChatStore } from './store';

function deriveTitle(events: ChatEvent[]): string | null {
	for (const e of events) {
		if (e.kind === 'text' && e.delta.trim().length > 0) {
			const line = e.delta.trim().split('\n')[0];
			return line.length > 80 ? line.slice(0, 80) + '…' : line;
		}
	}
	return null;
}

function deriveSessionMeta(events: ChatEvent[]): { cwd: string | null; model: string | null } {
	for (const e of events) {
		if (e.kind === 'session_init') {
			return { cwd: e.cwd, model: e.model };
		}
	}
	return { cwd: null, model: null };
}

/** Merge user-turn rows and JSONL events into a single render list ordered
 *  by best-known timestamp. User turns are tagged with `createdAt` from
 *  SQLite. JSONL events have no top-level timestamp but arrive in send
 *  order; we splice user turns into the timeline by sequence — each user
 *  turn precedes the assistant content it triggered. */
function mergeUserTurnsWithEvents(
	jsonlEvents: ChatEvent[],
	userTurns: Awaited<ReturnType<typeof loadUserTurns>>
): ChatEvent[] {
	if (userTurns.length === 0) return jsonlEvents;

	// JSONL groups assistant turns into runs separated by `done` events.
	// We splice one user_turn before each run (up to the count of user turns
	// we have). Anything left over goes at the end (e.g. the user just sent
	// a prompt and Claude hasn't responded yet).
	const merged: ChatEvent[] = [];
	let ut = 0;
	let inRun = false;
	for (const e of jsonlEvents) {
		if (!inRun && (e.kind === 'text' || e.kind === 'thinking' || e.kind === 'tool_use')) {
			if (ut < userTurns.length) {
				const t = userTurns[ut++];
				merged.push({
					kind: 'user_turn',
					text: t.text,
					sequence: t.sequence,
					createdAt: t.createdAt,
				});
			}
			inRun = true;
		}
		if (e.kind === 'done') inRun = false;
		merged.push(e);
	}
	while (ut < userTurns.length) {
		const t = userTurns[ut++];
		merged.push({
			kind: 'user_turn',
			text: t.text,
			sequence: t.sequence,
			createdAt: t.createdAt,
		});
	}
	return merged;
}

/** Interleave persisted user turns and assistant message-turns into one
 *  event list, ordered by their write timestamps. A user turn at T0 sorts
 *  before the assistant turn it triggered (persisted at turn-end, T1 > T0);
 *  ties break by insertion order. Used when JSONL has no assistant content
 *  to reconstruct from — the SQLite record is then the source of truth. */
function interleaveByTimestamp(
	userTurns: Awaited<ReturnType<typeof loadUserTurns>>,
	messages: PersistedMessage[]
): ChatEvent[] {
	interface Item {
		ts: number;
		order: number;
		events: ChatEvent[];
	}
	const items: Item[] = [];
	let order = 0;
	for (const t of userTurns) {
		items.push({
			ts: t.createdAt,
			order: order++,
			events: [{ kind: 'user_turn', text: t.text, sequence: t.sequence, createdAt: t.createdAt }],
		});
	}
	for (const m of messages) {
		items.push({ ts: m.createdAt, order: order++, events: m.events });
	}
	items.sort((a, b) => a.ts - b.ts || a.order - b.order);
	return items.flatMap((it) => it.events);
}

/**
 * Reconcile the three durable sources into the render list:
 *   - `chat_user_turns` (always — Claude's JSONL drops plain user messages)
 *   - `chat_messages` (assistant turns we persisted ourselves, this PR)
 *   - the on-disk JSONL transcript (claude only; backfill for older sessions)
 *
 * Strategy (see plans/shell discussion): JSONL stays authoritative *when it
 * actually has assistant content*, so existing sessions render byte-identical
 * (ordering, cost dividers, everything). Our persisted turns then only fill
 * gaps JSONL is missing — the classic "last turn aborted before claude
 * flushed its transcript" case, where the recovered turn appends in its
 * correct trailing position.
 *
 * When JSONL has *no* assistant content — a missing/mismatched
 * `claude_session_id`, format drift, or an engine that keeps no transcript at
 * all (gemini/codex) — we reconstruct entirely from the SQLite record,
 * interleaved by timestamp. This is the path that fixes the user-only-render
 * bug.
 *
 * Exported for unit testing — not part of the public chat barrel.
 */
export function assembleThread(
	jsonlEvents: ChatEvent[],
	userTurns: Awaited<ReturnType<typeof loadUserTurns>>,
	messages: PersistedMessage[]
): ChatEvent[] {
	const jsonlHasAssistant = jsonlEvents.some(
		(e) => e.kind === 'text' || e.kind === 'thinking' || e.kind === 'tool_use'
	);

	if (jsonlHasAssistant) {
		const base = mergeUserTurnsWithEvents(jsonlEvents, userTurns);
		if (messages.length === 0) return base;
		// Recovery: append any persisted assistant turn JSONL is missing. A turn
		// counts as "covered" if any of its content events already appear in the
		// base (matched by stable signature) — so partially-flushed turns aren't
		// duplicated, and only wholly-absent turns get spliced back in.
		const present = new Set(base.map(eventSignature));
		const extra: ChatEvent[] = [];
		for (const m of messages) {
			if (m.events.some((e) => present.has(eventSignature(e)))) continue;
			for (const e of m.events) {
				const sig = eventSignature(e);
				if (present.has(sig)) continue;
				present.add(sig);
				extra.push(e);
			}
		}
		return extra.length > 0 ? [...base, ...extra] : base;
	}

	// JSONL gave us nothing to render the assistant side from.
	if (messages.length === 0) {
		// Nothing persisted either — preserve the legacy user-turns-only render.
		return mergeUserTurnsWithEvents(jsonlEvents, userTurns);
	}
	return interleaveByTimestamp(userTurns, messages);
}

/**
 * Bind a route param (the stable `threadId`) to a chat thread:
 *   1. Find or create the thread row in SQLite.
 *   2. Hydrate the store from JSONL (if a Claude session is associated) +
 *      persisted user turns.
 *   3. Ask the adapter to attach a live subscription. The adapter writes
 *      events directly into the store via appendEvents.
 *
 * `threadId` is a stable uuid (frontend-minted on chat creation). For
 * back-compat with legacy `/sessions/<claudeUUID>` URLs, the route's
 * beforeLoad resolves Claude UUIDs to their thread id before this hook
 * runs — we only ever see internal ids here.
 */
export function useThread(threadId: string | null): {
	threadId: string | null;
	loading: boolean;
	error: string | null;
} {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const upsertThread = useChatStore((s) => s.upsertThread);
	const activeProjectId = useShellStore((s) => s.activeProjectId);

	useEffect(() => {
		if (!threadId) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);

		(async () => {
			try {
				let thread = await findThreadById(threadId);

				// Load JSONL events if we already know a Claude session id (i.e.
				// this thread has talked to claude before). Brand-new threads
				// start with an empty event list.
				let jsonlEvents: ChatEvent[] = [];
				const claudeId = thread?.claudeSessionId ?? null;
				if (claudeId) {
					try {
						jsonlEvents = await claudeReadJsonl(claudeId);
					} catch (e) {
						if (e instanceof Error && !e.message.includes('not found')) {
							console.warn('claudeReadJsonl:', e);
						}
					}
				}
				const userTurns = await loadUserTurns(threadId);
				const persistedMessages = await loadMessages(threadId);
				const meta = deriveSessionMeta(jsonlEvents);
				const title = deriveTitle(jsonlEvents);

				if (!thread) {
					const adapterId = defaultChatAdapterId();
					await createThread({
						id: threadId,
						adapterId,
						cwd: meta.cwd || activeProjectCwd(),
						claudeSessionId: null,
						model: meta.model,
						title,
						projectId: activeProjectId,
					});
					thread = (await findThreadById(threadId)) ?? {
						id: threadId,
						adapterId,
						engineId: adapterId,
						title,
						cwd: meta.cwd || activeProjectCwd(),
						model: meta.model,
						claudeSessionId: null,
						ptyId: null,
						projectId: activeProjectId,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
				} else if (
					(meta.cwd && meta.cwd !== thread.cwd) ||
					(meta.model && meta.model !== thread.model) ||
					(title && title !== thread.title)
				) {
					await updateThreadMeta(thread.id, {
						cwd: meta.cwd ?? thread.cwd,
						model: meta.model ?? thread.model,
						title: title ?? thread.title,
					});
					thread = {
						...thread,
						cwd: meta.cwd ?? thread.cwd,
						model: meta.model ?? thread.model,
						title: title ?? thread.title,
					};
				}

				if (cancelled) return;
				const merged = assembleThread(jsonlEvents, userTurns, persistedMessages);
				upsertThread(thread, merged);

				// Attach the live subscription via the thread's resolved adapter.
				// Phase 10 — `getAdapter` returns the ACP adapter by default; threads
				// persisted under the legacy 'cli' adapter still resolve to it.
				try {
					const adapter = getAdapter(thread.adapterId);
					await adapter.attach?.(
						threadId,
						thread.cwd || activeProjectCwd(),
						thread.projectId ?? activeProjectId
					);
				} catch (e) {
					console.warn('adapter.attach failed:', e);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [threadId, upsertThread, activeProjectId]);

	// JSONL reconciler: while the thread is live, poll JSONL every 2s for
	// canonical events the live subscription may have missed (e.g. during
	// adapter restart). Identity is approximate (kind + payload hash) since
	// events don't carry stable ids on the wire.
	useEffect(() => {
		if (!threadId) return;
		const state = useChatStore.getState().threads[threadId];
		const claudeId = state?.thread.claudeSessionId;
		if (!claudeId) return;

		let cancelled = false;
		const reconcile = async () => {
			if (cancelled) return;
			try {
				const onDisk = await claudeReadJsonl(claudeId);
				if (cancelled) return;
				const current = useChatStore.getState().threads[threadId];
				if (!current) return;
				const canonicalKinds = new Set([
					'text',
					'thinking',
					'tool_use',
					'tool_result',
					'done',
					'rate_limit',
					'artifact',
				]);
				// Dedup via the shared `eventSignature` (store.ts) so the reconciler
				// and the SQLite⊕JSONL reload assembler agree on identity.
				const existing = new Set(current.events.map(eventSignature));
				const missing = onDisk.filter(
					(e) => canonicalKinds.has(e.kind) && !existing.has(eventSignature(e))
				);
				if (missing.length > 0) {
					useChatStore.getState().appendEvents(threadId, missing);
				}
			} catch (e) {
				if (e instanceof Error && !e.message.includes('not found')) {
					console.warn('jsonl reconcile:', e);
				}
			}
		};
		const firstId = setTimeout(reconcile, 1500);
		const intervalId = setInterval(reconcile, 2000);
		return () => {
			cancelled = true;
			clearTimeout(firstId);
			clearInterval(intervalId);
		};
	}, [threadId]);

	return { threadId, loading, error };
}

/** Back-compat alias for the v1 hook name. New code should call useThread. */
export const useEnsureThreadForSession = useThread;

export function useThreadState(threadId: string | null): ThreadState | null {
	return useChatStore((s) => (threadId ? (s.threads[threadId] ?? null) : null));
}

export interface ChatActions {
	send: (text: string) => Promise<void>;
	cancel: () => Promise<void>;
	isStreaming: boolean;
	canSend: boolean;
	/** Non-null when the last `send` threw. UI surfaces this in a banner with
	 *  a Retry affordance (PR2.2 wires retry properly). */
	lastError: string | null;
}

/** ADR-013 Phase 6 — `engineId` override is the composer picker's current
 *  per-turn selection. When provided it routes the send through that
 *  engine's adapter; when omitted we fall back to `thread.adapterId`
 *  (back-compat with all the legacy single-engine call sites). The
 *  thread's persisted `engineId` column stays pinned to whatever it was
 *  at creation — we don't mutate it on per-turn swap. */
export function useChatActions(threadId: string | null, engineId?: string): ChatActions {
	const state = useChatStore((s) => (threadId ? (s.threads[threadId] ?? null) : null));
	const setStatus = useChatStore((s) => s.setStatus);
	const setStream = useChatStore((s) => s.setStream);
	const appendEvents = useChatStore((s) => s.appendEvents);
	const clearPendingTurn = useChatStore((s) => s.clearPendingTurn);
	const sendingRef = useRef(false);
	const [lastError, setLastError] = useState<string | null>(null);

	const isStreaming = state?.status === 'streaming';

	const send = async (text: string) => {
		if (!threadId || sendingRef.current) return;
		if (text.trim().length === 0) return;
		sendingRef.current = true;
		setLastError(null);
		try {
			// Persist the user turn first so it survives reloads even if the
			// spawn fails. The store entry below is a render echo; SQLite is
			// canonical.
			const turn = await appendUserTurn(threadId, text);
			appendEvents(threadId, [
				{
					kind: 'user_turn',
					text: turn.text,
					sequence: turn.sequence,
					createdAt: turn.createdAt,
				},
			]);

			// Per-turn engine routing (ADR-013 §4): prefer the composer's
			// `engineId` override so each send hits the picker's current
			// selection. Fall back to the thread's adapterId for callers
			// that don't yet thread the picker through (test harnesses,
			// pin-routed prompts, etc).
			const adapter = getAdapter(engineId ?? state?.thread.adapterId ?? defaultChatAdapterId());
			const { streamId, iterable } = adapter.send({ threadId, text });
			setStream(threadId, streamId);
			setStatus(threadId, 'streaming');

			try {
				for await (const _ev of iterable) {
					// Drain. Store mutations happen in adapter.onEvent now.
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				setStatus(threadId, 'error', msg);
				setLastError(msg);
			} finally {
				setStream(threadId, null);
				if (useChatStore.getState().threads[threadId]?.status === 'streaming') {
					setStatus(threadId, 'idle');
				}
				// Persist the assistant side of this turn so reopening the thread
				// no longer depends on claude's JSONL transcript (and works at all
				// for engines that keep no transcript — gemini/codex). The user
				// turn was already persisted up top; drain the per-turn buffer and
				// drop the synthetic `user_turn` echo before writing the assistant
				// row. Best-effort: a persist failure must not surface as a send
				// error — the JSONL reconciler still backfills claude threads.
				const drained = clearPendingTurn(threadId).filter((e) => e.kind !== 'user_turn');
				if (drained.length > 0) {
					try {
						await appendMessage(threadId, 'assistant', drained);
					} catch (persistErr) {
						console.warn('appendMessage (assistant turn):', persistErr);
					}
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('chat send failed:', e);
			setStatus(threadId, 'error', msg);
			setLastError(msg);
		} finally {
			sendingRef.current = false;
		}
	};

	const cancel = async () => {
		if (!threadId || !state || !state.streamId) return;
		// Cancel always routes through the engine that's currently streaming
		// — we don't know which engine the live streamId belongs to other
		// than `thread.adapterId` (set when the send started). Using the
		// picker's override here would mis-route a cancel to a different
		// engine than the in-flight turn.
		const adapter = getAdapter(state.thread.adapterId);
		await adapter.cancel(state.streamId);
	};

	return useMemo(
		() => ({
			send,
			cancel,
			isStreaming,
			canSend: !!threadId && !isStreaming,
			lastError,
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[threadId, isStreaming, state?.streamId, state?.thread.adapterId, engineId, lastError]
	);
}

/** One-shot hook: clear stale `pty_id` rows on app cold start, and tear
 *  down any orphaned Rust streaming children left over from the previous
 *  process. Mounted once at workspace level. */
export function useChatColdStart(): void {
	const ran = useRef(false);
	useEffect(() => {
		if (ran.current) return;
		ran.current = true;
		void (async () => {
			try {
				await clearLivePtys();
			} catch (e) {
				console.warn('clearLivePtys:', e);
			}
			try {
				await pruneOldMessages();
			} catch (e) {
				console.warn('pruneOldMessages:', e);
			}
			try {
				const { sessionDestroyAll } = await import('@/lib/tauri-cmd');
				await sessionDestroyAll();
			} catch (e) {
				console.warn('sessionDestroyAll:', e);
			}
		})();
		// Also: kill streaming children on window unload so dev reloads /
		// window-close don't leave zombies. PR2.3 hardens this further.
		const onUnload = () => {
			void (async () => {
				try {
					const { sessionDestroyAll } = await import('@/lib/tauri-cmd');
					await sessionDestroyAll();
				} catch {
					// best-effort, page is going away
				}
			})();
		};
		window.addEventListener('beforeunload', onUnload);
		return () => window.removeEventListener('beforeunload', onUnload);
	}, []);
}

/** Mint a fresh, stable thread id. Used by every "New chat" entry point. */
export function mintThreadId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	// Sufficiently unique fallback for environments without crypto.randomUUID.
	return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
