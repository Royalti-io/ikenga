// Cross-component prompt queue for chat threads.
//
// When the pin-routing dispatcher decides a pin should land in the
// side-pane Chat (no claude PTY available), it has no way to call into a
// specific Composer component directly. Instead the shell-level listener
// enqueues the structured prompt here, keyed by thread id; the target
// thread's Composer reads + consumes it on mount/effect and pre-fills its
// textarea so the user just hits Enter to send.
//
// The store deliberately holds one prompt per thread — re-queueing while
// a prompt is still pending overwrites the previous one. That keeps the
// UX deterministic if the user spams pins without dispatching them.

import { create } from 'zustand';

interface PendingPromptsState {
	byThread: Record<string, string>;
	/** Set or overwrite the pending prompt for a thread. */
	enqueue: (threadId: string, prompt: string) => void;
	/** Read + remove the pending prompt for a thread. Returns `null` if none. */
	consume: (threadId: string) => string | null;
}

export const usePendingPrompts = create<PendingPromptsState>((set, get) => ({
	byThread: {},
	enqueue: (threadId, prompt) => set((s) => ({ byThread: { ...s.byThread, [threadId]: prompt } })),
	consume: (threadId) => {
		const cur = get().byThread[threadId];
		if (cur === undefined) return null;
		set((s) => {
			const next = { ...s.byThread };
			delete next[threadId];
			return { byThread: next };
		});
		return cur;
	},
}));
