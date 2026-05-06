/**
 * Chat hooks — the only API surface the route page / pane chat-view should
 * use. Coordinates registry + store + persist.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { claudeListenSession, claudeReadJsonl, type ChatEvent } from '@/lib/tauri-cmd';
import { useLiveSessions } from '@/lib/queries/live-sessions';
import {
  createThread,
  findThreadById,
  findThreadByClaudeSessionId,
  updateThreadMeta,
} from './persist';
import { getAdapter } from './registry';
import { useChatStore, type ThreadState } from './store';

const DEFAULT_ADAPTER = 'cli';

function deriveTitle(events: ChatEvent[]): string | null {
  for (const e of events) {
    if (e.kind === 'text' && e.delta.trim().length > 0) {
      const line = e.delta.trim().split('\n')[0];
      return line.length > 80 ? line.slice(0, 80) + '…' : line;
    }
  }
  return null;
}

function deriveSessionMeta(
  events: ChatEvent[],
): { cwd: string | null; model: string | null } {
  for (const e of events) {
    if (e.kind === 'session_init') {
      return { cwd: e.cwd, model: e.model };
    }
  }
  return { cwd: null, model: null };
}

/**
 * Bind the current route's claudeSessionId to a chat thread:
 *   1. Find or create the thread row in SQLite.
 *   2. Hydrate the store from the on-disk JSONL (canonical replay).
 *   3. Subscribe to live events if a PTY is currently running for it.
 */
export function useEnsureThreadForSession(claudeSessionId: string | null): {
  threadId: string | null;
  loading: boolean;
  error: string | null;
} {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const upsertThread = useChatStore((s) => s.upsertThread);
  const setLiveAttached = useChatStore((s) => s.setLiveAttached);
  const appendEvents = useChatStore((s) => s.appendEvents);
  const setStatus = useChatStore((s) => s.setStatus);
  const live = useLiveSessions((s) =>
    claudeSessionId ? s.sessions[claudeSessionId] : undefined,
  );

  useEffect(() => {
    if (!claudeSessionId) {
      setThreadId(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // We use `claudeSessionId` directly as the chat thread id so there's
        // exactly one row per conversation. Rust's `upsert_thread` (in
        // commands/claude.rs) writes its own rows keyed on placeholder uuids;
        // those are independent and harmless.
        const threadIdValue = claudeSessionId;
        let thread =
          (await findThreadById(threadIdValue)) ??
          (await findThreadByClaudeSessionId(claudeSessionId));
        let events: ChatEvent[] = [];
        try {
          events = await claudeReadJsonl(claudeSessionId);
        } catch (e) {
          // Brand-new session may not have a JSONL on disk yet.
          if (e instanceof Error && !e.message.includes('not found')) {
            console.warn('claudeReadJsonl:', e);
          }
        }
        const meta = deriveSessionMeta(events);
        const title = deriveTitle(events);

        if (!thread) {
          await createThread({
            id: threadIdValue,
            adapterId: DEFAULT_ADAPTER,
            cwd: meta.cwd ?? '',
            claudeSessionId,
            model: meta.model,
            title,
          });
          thread = (await findThreadById(threadIdValue)) ?? {
            id: threadIdValue,
            adapterId: DEFAULT_ADAPTER,
            title,
            cwd: meta.cwd ?? '',
            model: meta.model,
            claudeSessionId,
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
        upsertThread(thread, events);
        setThreadId(thread.id);
        setLiveAttached(thread.id, !!live);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeSessionId]);

  // Subscribe to live deltas while a PTY is registered for this session id.
  useEffect(() => {
    if (!claudeSessionId || !threadId || !live) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Don't unconditionally set 'streaming' on every mount. The route
    // remounts when the URL transitions from placeholder→real session id;
    // if the assistant 'done' event fired during that gap we'd be stuck on
    // 'streaming' forever. Only flip to streaming if a turn is actually in
    // flight (pendingTurn is non-empty); otherwise leave whatever the
    // previous status was.
    const current = useChatStore.getState().threads[threadId];
    if (current && current.pendingTurn.length > 0 && current.status !== 'streaming') {
      setStatus(threadId, 'streaming');
    }
    setLiveAttached(threadId, true);
    const setThread = useChatStore.getState().setThread;
    claudeListenSession(claudeSessionId, (event) => {
      appendEvents(threadId, [event]);
      // Any incoming event implicitly means the turn is live — sync the
      // status so the UI reflects reality even if the second-mount path
      // didn't set it above.
      if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use') {
        const s = useChatStore.getState().threads[threadId]?.status;
        if (s !== 'streaming') setStatus(threadId, 'streaming');
      }
      // Promote the placeholder session id to the real one as soon as the
      // parser sees system:init. The route reads this to update its URL.
      if (event.kind === 'session_init' && event.sessionId) {
        const stored = useChatStore.getState().threads[threadId]?.thread.claudeSessionId;
        if (event.sessionId !== stored) {
          setThread(threadId, { claudeSessionId: event.sessionId });
          void updateThreadMeta(threadId, { claudeSessionId: event.sessionId });
        }
      }
      if (event.kind === 'done') {
        setStatus(threadId, 'idle');
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch((err) => console.error('listen session:', err));
    return () => {
      cancelled = true;
      unlisten?.();
      setLiveAttached(threadId, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeSessionId, threadId, !!live]);

  // JSONL reconciliation. The route remounts on placeholder→real session
  // id navigation; any events Rust emitted during that gap have no live
  // listener attached, so they're lost from the in-memory store. While
  // the session is live, poll the JSONL every 2s and adopt it whenever
  // it's longer than the in-memory event list. Stops on unmount or once
  // the live listener has reported 'done' (status flips to idle).
  useEffect(() => {
    if (!claudeSessionId || !threadId) return;
    if (claudeSessionId.startsWith('pending-')) return;
    let cancelled = false;
    const reconcile = async () => {
      if (cancelled) return;
      try {
        const onDisk = await claudeReadJsonl(claudeSessionId);
        if (cancelled) return;
        const current = useChatStore.getState().threads[threadId];
        if (!current) return;
        // The live stream and JSONL have non-overlapping event kinds:
        // hooks (`hook_started`/`hook_response`/`session_init`) only
        // appear on the live channel, while `text`, `thinking`,
        // `tool_use`/`tool_result`, and `done` are the canonical record
        // on disk. So we can't compare lengths — they're different
        // populations. Instead, append each JSONL event of a "canonical"
        // kind that isn't already represented in the store. Identity is
        // approximate (kind + serialized payload) since events don't
        // carry stable ids; coalesceTail handles delta merging.
        const canonicalKinds = new Set([
          'text',
          'thinking',
          'tool_use',
          'tool_result',
          'done',
          'rate_limit',
          'artifact',
        ]);
        const sigOf = (e: typeof onDisk[number]) =>
          `${e.kind}:${JSON.stringify(e)}`;
        const existing = new Set(current.events.map(sigOf));
        const missing = onDisk.filter(
          (e) => canonicalKinds.has(e.kind) && !existing.has(sigOf(e)),
        );
        if (missing.length > 0) {
          appendEvents(threadId, missing);
        }
        // The Claude CLI flushes a turn's `assistant` text to JSONL at
        // turn end (not progressively), so any text that lands on disk
        // means the turn completed. If status is still 'streaming' here,
        // the live 'done' event was lost during the placeholder→real
        // session-id navigation gap — sync from disk.
        const hasDoneSignal =
          onDisk.some((e) => e.kind === 'done') ||
          missing.some((e) => e.kind === 'text' || e.kind === 'done');
        if (hasDoneSignal) {
          const s = useChatStore.getState().threads[threadId]?.status;
          if (s === 'streaming') {
            useChatStore.getState().setStatus(threadId, 'idle');
          }
        }
      } catch (e) {
        if (e instanceof Error && !e.message.includes('not found')) {
          console.warn('jsonl reconcile:', e);
        }
      }
    };
    // Initial reconcile after a brief delay so disk has a chance to flush.
    const firstId = setTimeout(reconcile, 1500);
    // Polling loop while live. 2s is fast enough that missed-event lag is
    // imperceptible, slow enough that JSONL parses don't dominate CPU.
    const intervalId = setInterval(reconcile, 2000);
    return () => {
      cancelled = true;
      clearTimeout(firstId);
      clearInterval(intervalId);
    };
  }, [claudeSessionId, threadId]);

  return { threadId, loading, error };
}

export function useThreadState(threadId: string | null): ThreadState | null {
  return useChatStore((s) => (threadId ? s.threads[threadId] ?? null : null));
}

export interface ChatActions {
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  isStreaming: boolean;
  canSend: boolean;
}

export function useChatActions(threadId: string | null): ChatActions {
  const state = useChatStore((s) => (threadId ? s.threads[threadId] ?? null : null));
  const setStatus = useChatStore((s) => s.setStatus);
  const setStream = useChatStore((s) => s.setStream);
  const appendEvents = useChatStore((s) => s.appendEvents);
  const sendingRef = useRef(false);

  const isStreaming = state?.status === 'streaming';

  const send = async (text: string) => {
    if (!threadId || !state || sendingRef.current) return;
    if (text.trim().length === 0) return;
    sendingRef.current = true;
    try {
      // Locally echo the user message into the event buffer so it's visible
      // immediately. The on-disk JSONL parser drops plain-string user content
      // (only tool_result-shaped user envelopes surface via the live stream),
      // so we synthesize a system_hook the Thread renders as a user bubble.
      // JSONL remains the canonical record; on next reopen, this echo is
      // replaced by whatever the JSONL says.
      appendEvents(threadId, [
        {
          kind: 'system_hook',
          hookEvent: 'user_message',
          name: 'user',
          content: text,
        } as ChatEvent,
      ]);

      const adapter = getAdapter(state.thread.adapterId);
      const { streamId, iterable } = adapter.send({ threadId, text });
      setStream(threadId, streamId);
      setStatus(threadId, 'streaming');

      // Drain the iterable. Store mutations happen in the live listener
      // (claudeListenSession) attached by useEnsureThreadForSession; the
      // iterable is the cancellation/lifecycle channel.
      try {
        for await (const _ev of iterable) {
          // intentionally empty — see comment above
        }
      } catch (e) {
        setStatus(threadId, 'error', e instanceof Error ? e.message : String(e));
      } finally {
        setStream(threadId, null);
        if (useChatStore.getState().threads[threadId]?.status === 'streaming') {
          setStatus(threadId, 'idle');
        }
      }
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
    () => ({ send, cancel, isStreaming, canSend: !!threadId && !isStreaming }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, isStreaming, state?.streamId, state?.thread.adapterId],
  );
}

/** One-shot hook: clear stale `pty_id` rows on app cold start. */
export function useChatColdStart(): void {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        const { clearLivePtys } = await import('./persist');
        await clearLivePtys();
      } catch (e) {
        console.warn('clearLivePtys:', e);
      }
    })();
  }, []);
}
