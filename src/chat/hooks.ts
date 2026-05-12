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
import { defaultCwd } from '@/lib/shell/default-cwd';
import { claudeReadJsonl, type ChatEvent } from '@/lib/tauri-cmd';
import {
	appendUserTurn,
	clearLivePtys,
	createThread,
	findThreadById,
	loadUserTurns,
	updateThreadMeta,
} from './persist';
import { getAdapter } from './registry';
import { useChatStore, type ThreadState } from './store';
import { defaultChatAdapterId } from './default-adapter';

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
				const meta = deriveSessionMeta(jsonlEvents);
				const title = deriveTitle(jsonlEvents);

				if (!thread) {
					const adapterId = defaultChatAdapterId();
					await createThread({
						id: threadId,
						adapterId,
						cwd: meta.cwd ?? '',
						claudeSessionId: null,
						model: meta.model,
						title,
					});
					thread = (await findThreadById(threadId)) ?? {
						id: threadId,
						adapterId,
						title,
						cwd: meta.cwd ?? '',
						model: meta.model,
						claudeSessionId: null,
						ptyId: null,
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
				const merged = mergeUserTurnsWithEvents(jsonlEvents, userTurns);
				upsertThread(thread, merged);

				// Attach the live subscription via the thread's resolved adapter.
				// Phase 10 — `getAdapter` returns the ACP adapter by default; threads
				// persisted under the legacy 'cli' adapter still resolve to it.
				try {
					const adapter = getAdapter(thread.adapterId);
					await adapter.attach?.(threadId, thread.cwd || defaultCwd());
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
	}, [threadId, upsertThread]);

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
				// Identity:
				//   * text / thinking — keyed by messageId (stable across live + JSONL),
				//     since the live stream may have coalesced multiple chunks into
				//     one block whose JSON.stringify won't match JSONL's split blocks.
				//   * tool_use / tool_result — stable id from the envelope.
				//   * everything else — fall back to JSON.stringify.
				const sigOf = (e: (typeof onDisk)[number]): string => {
					if ((e.kind === 'text' || e.kind === 'thinking') && e.messageId) {
						return `${e.kind}:m:${e.messageId}`;
					}
					if (e.kind === 'tool_use' || e.kind === 'tool_result') {
						return `${e.kind}:id:${e.id}`;
					}
					return `${e.kind}:${JSON.stringify(e)}`;
				};
				const existing = new Set(current.events.map(sigOf));
				const missing = onDisk.filter((e) => canonicalKinds.has(e.kind) && !existing.has(sigOf(e)));
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

export function useChatActions(threadId: string | null): ChatActions {
	const state = useChatStore((s) => (threadId ? (s.threads[threadId] ?? null) : null));
	const setStatus = useChatStore((s) => s.setStatus);
	const setStream = useChatStore((s) => s.setStream);
	const appendEvents = useChatStore((s) => s.appendEvents);
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

			const adapter = getAdapter(state?.thread.adapterId ?? defaultChatAdapterId());
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
		[threadId, isStreaming, state?.streamId, state?.thread.adapterId, lastError]
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
