/**
 * Chat store — single source of truth for thread state, event buffers, and
 * streaming status. Thread ids are internal (uuid-ish); they bind to a Claude
 * Code session id once we know it.
 *
 * The store coalesces contiguous text/thinking deltas inline as events flow
 * through, which keeps render volume sane during streaming. Tool-use ↔
 * tool-result pairing is computed in a memoized selector (see `pairToolCalls`).
 */

import { create } from 'zustand';
import type { ChatEvent } from '@/lib/tauri-cmd';
import type { ChatThread } from './adapter';

export type ThreadStatus = 'idle' | 'streaming' | 'error' | 'interrupted';

export interface ThreadState {
  thread: ChatThread;
  events: ChatEvent[];
  status: ThreadStatus;
  liveAttached: boolean;
  /** Set during streaming so cancellation can target the active turn. */
  streamId: string | null;
  /** Buffer of events for the current turn — flushed to SQLite on turn end. */
  pendingTurn: ChatEvent[];
  /** Last error message, if status === 'error'. */
  errorMessage: string | null;
}

interface ChatStoreState {
  threads: Record<string, ThreadState>;
  /** True until cold-start hygiene (clearLivePtys) finishes. */
  hydratedAt: number | null;

  upsertThread(thread: ChatThread, events?: ChatEvent[]): void;
  setThread(id: string, patch: Partial<ChatThread>): void;
  appendEvents(threadId: string, events: ChatEvent[]): void;
  /** Replace the full event list (used by JSONL replay on reopen). */
  setEvents(threadId: string, events: ChatEvent[]): void;
  setStatus(threadId: string, status: ThreadStatus, errorMessage?: string): void;
  setStream(threadId: string, streamId: string | null): void;
  setLiveAttached(threadId: string, live: boolean): void;
  clearPendingTurn(threadId: string): ChatEvent[];
  removeThread(threadId: string): void;
  setHydrated(): void;
  reset(): void;
}

function coalesceTail(events: ChatEvent[], next: ChatEvent): ChatEvent[] {
  const last = events[events.length - 1];
  if (last && last.kind === 'text' && next.kind === 'text') {
    const merged: ChatEvent = { kind: 'text', delta: last.delta + next.delta };
    return [...events.slice(0, -1), merged];
  }
  if (last && last.kind === 'thinking' && next.kind === 'thinking') {
    const merged: ChatEvent = { kind: 'thinking', delta: last.delta + next.delta };
    return [...events.slice(0, -1), merged];
  }
  return [...events, next];
}

export function coalesceAll(events: ChatEvent[]): ChatEvent[] {
  return events.reduce<ChatEvent[]>((acc, e) => coalesceTail(acc, e), []);
}

export const useChatStore = create<ChatStoreState>((set) => ({
  threads: {},
  hydratedAt: null,

  upsertThread: (thread, events) =>
    set((state) => {
      const existing = state.threads[thread.id];
      const next: ThreadState = existing
        ? { ...existing, thread: { ...existing.thread, ...thread } }
        : {
            thread,
            events: events ? coalesceAll(events) : [],
            status: 'idle',
            liveAttached: false,
            streamId: null,
            pendingTurn: [],
            errorMessage: null,
          };
      // Only replace existing events when the new list is at least as long.
      // The route remounts on placeholder→real session-id navigation; if
      // the JSONL read on the new mount races ahead of disk flushes (or
      // returns [] for a brand-new session), we'd otherwise wipe events
      // already accumulated by the previous mount's live listener.
      if (events && existing && events.length >= existing.events.length) {
        next.events = coalesceAll(events);
      }
      return { threads: { ...state.threads, [thread.id]: next } };
    }),

  setThread: (id, patch) =>
    set((state) => {
      const existing = state.threads[id];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [id]: { ...existing, thread: { ...existing.thread, ...patch } },
        },
      };
    }),

  appendEvents: (threadId, events) =>
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      let merged = existing.events;
      let pending = existing.pendingTurn;
      for (const e of events) {
        merged = coalesceTail(merged, e);
        pending = [...pending, e];
      }
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...existing, events: merged, pendingTurn: pending },
        },
      };
    }),

  setEvents: (threadId, events) =>
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...existing, events: coalesceAll(events), pendingTurn: [] },
        },
      };
    }),

  setStatus: (threadId, status, errorMessage) =>
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...existing,
            status,
            errorMessage: status === 'error' ? errorMessage ?? existing.errorMessage : null,
          },
        },
      };
    }),

  setStream: (threadId, streamId) =>
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...existing, streamId },
        },
      };
    }),

  setLiveAttached: (threadId, live) =>
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...existing, liveAttached: live },
        },
      };
    }),

  clearPendingTurn: (threadId) => {
    let drained: ChatEvent[] = [];
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      drained = existing.pendingTurn;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...existing, pendingTurn: [] },
        },
      };
    });
    return drained;
  },

  removeThread: (threadId) =>
    set((state) => {
      const next = { ...state.threads };
      delete next[threadId];
      return { threads: next };
    }),

  setHydrated: () => set({ hydratedAt: Date.now() }),

  reset: () => set({ threads: {}, hydratedAt: null }),
}));

// ─── Selectors ──────────────────────────────────────────────────────────────

export interface PairedToolCall {
  use: Extract<ChatEvent, { kind: 'tool_use' }>;
  result: Extract<ChatEvent, { kind: 'tool_result' }> | null;
}

export interface RenderItem {
  /** Stable key for React. */
  key: string;
  event: ChatEvent | { kind: 'tool_pair'; pair: PairedToolCall };
}

/** Build a render-ready list:
 *   - Pairs tool_use with its tool_result (skipping the standalone result).
 *   - Filters out 'unknown' from prod render (debug strip handles them).
 *   - Leaves text / thinking / artifact / done / hooks / errors as-is.
 */
export function buildRenderItems(events: ChatEvent[], includeDebug = false): RenderItem[] {
  const resultsById = new Map<string, Extract<ChatEvent, { kind: 'tool_result' }>>();
  for (const e of events) {
    if (e.kind === 'tool_result') resultsById.set(e.id, e);
  }
  const items: RenderItem[] = [];
  let idx = 0;
  for (const e of events) {
    idx += 1;
    if (e.kind === 'tool_result') continue; // surfaced via its tool_use
    if (e.kind === 'tool_use') {
      items.push({
        key: `tool:${e.id}`,
        event: { kind: 'tool_pair', pair: { use: e, result: resultsById.get(e.id) ?? null } },
      });
      continue;
    }
    if ((e.kind === 'unknown' || e.kind === 'parse_error') && !includeDebug) continue;
    items.push({ key: `${e.kind}:${idx}`, event: e });
  }
  return items;
}

/** Children of a Task tool, looked up by parentToolUseId. */
export function findToolChildren(
  events: ChatEvent[],
  parentId: string,
): PairedToolCall[] {
  const resultsById = new Map<string, Extract<ChatEvent, { kind: 'tool_result' }>>();
  for (const e of events) {
    if (e.kind === 'tool_result' && e.parentToolUseId === parentId) {
      resultsById.set(e.id, e);
    }
  }
  const out: PairedToolCall[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use' && e.parentToolUseId === parentId) {
      out.push({ use: e, result: resultsById.get(e.id) ?? null });
    }
  }
  return out;
}

export function selectDebugEvents(events: ChatEvent[]): ChatEvent[] {
  return events.filter((e) => e.kind === 'unknown' || e.kind === 'parse_error');
}
