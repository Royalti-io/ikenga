// Pending-handoff store for the wizard's grid → loupe swap.
//
// When the watcher detects the agent's first new `.html`, we swap the
// Studio leaf's view in place but the wizard's terminal pane is still
// sitting to the right. The user's stored preference (see handoff-pref)
// decides whether to silently attach + close the terminal pane, leave it
// alone, or ask. If "ask", the watcher posts a `PendingHandoff` here and
// the workspace-mounted prompt component picks it up and renders the
// modal — keeps the watcher's side-effect path React-free.

import { create } from 'zustand';

export interface PendingHandoff {
	terminalSessionId: string;
	terminalLeafId: string;
	studioLeafId: string;
	artifactPath: string;
}

interface HandoffState {
	pending: PendingHandoff | null;
	request: (h: PendingHandoff) => void;
	resolve: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
	pending: null,
	request: (h) => set({ pending: h }),
	resolve: () => set({ pending: null }),
}));
