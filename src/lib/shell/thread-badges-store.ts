// Phase 9 (ACP migration): per-thread "needs your attention" badge counts.
//
// The `acp-notify-bridge.ts` dispatcher calls `bump(threadId)` whenever an
// `acp://notify` lands AND the user isn't already focused on that thread.
// Surfaces (sessions sidebar, command palette, etc.) read from this store
// to render a dot or count on the relevant thread row, and call
// `clear(threadId)` when the user navigates to the thread.
//
// Deliberately tiny + in-memory: badge counts shouldn't survive a hot
// reload or app relaunch — the OS already delivered the original
// notification, and stale badges from yesterday's session are noise.

import { create } from 'zustand';

export interface ThreadBadgesState {
	/** Per-thread unread count. Threads with 0 are kept out of the map so
	 *  selector iteration is cheap. */
	counts: Record<string, number>;

	/** Increment the count for `threadId` by 1. The dispatcher calls this
	 *  whenever it decides to surface a notification to the user. */
	bump: (threadId: string) => void;

	/** Reset the count for `threadId` to 0 (drops the key). Call this
	 *  when the user navigates to the thread — the in-UI surface has
	 *  acknowledged the pending notifications. */
	clear: (threadId: string) => void;

	/** Reset every thread's count. Useful for "Mark all as read" UX and
	 *  for vitest cleanup. Not currently surfaced in the UI. */
	clearAll: () => void;
}

export const useThreadBadges = create<ThreadBadgesState>((set) => ({
	counts: {},
	bump: (threadId) =>
		set((s) => ({
			counts: { ...s.counts, [threadId]: (s.counts[threadId] ?? 0) + 1 },
		})),
	clear: (threadId) =>
		set((s) => {
			if (!(threadId in s.counts)) return s;
			const next = { ...s.counts };
			delete next[threadId];
			return { counts: next };
		}),
	clearAll: () => set({ counts: {} }),
}));

/** Selector helper for components that just need "is this thread waiting on
 *  me?" — avoids subscribing to the full counts map. */
export function useThreadBadgeCount(threadId: string | null | undefined): number {
	return useThreadBadges((s) =>
		threadId ? (s.counts[threadId] ?? 0) : 0,
	);
}
