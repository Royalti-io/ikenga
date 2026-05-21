// Pending-confirm store for `host.startChatSession`.
//
// A pkg iframe calling the verb (e.g. a plan board's "Start session") hands
// the shell a seed *prompt* derived from plan text. Per 01-plan §Risks
// (prompt-injection via auto-seeded sessions), that text is surfaced to the
// user for explicit approval before it's sent to an engine — and since
// nothing sends without a click, this confirm also serves as the rate gate
// against unbounded auto-spawns.
//
// The verb (in pkg-iframe-host.tsx) is a non-React async path, so it requests
// a modal here and awaits the promise; the workspace-mounted prompt component
// renders the dialog and resolves it. Mirrors the wizard's handoff-store.

import { create } from 'zustand';

export interface PendingSeedConfirm {
	/** Id of the pkg that requested the session — shown so the user knows
	 *  who is asking. */
	pkgId: string;
	/** The seed prompt that will be sent as the thread's first user turn. */
	prompt: string;
	/** Pane title the pkg proposed, or null to use the helper's default. */
	title: string | null;
	/** Resolves the awaiting verb: true = approved + send, false = declined. */
	resolve: (approved: boolean) => void;
}

interface SeedChatConfirmState {
	pending: PendingSeedConfirm | null;
	/** Request user approval for a seeded session. Resolves when the user
	 *  approves or declines (or dismisses, which counts as decline). Only one
	 *  request is live at a time; a second request while one is pending
	 *  declines the earlier one so the verb's promise never dangles. */
	request: (req: Omit<PendingSeedConfirm, 'resolve'>) => Promise<boolean>;
	/** Settle the live request with the user's decision and clear it. */
	settle: (approved: boolean) => void;
}

export const useSeedChatConfirmStore = create<SeedChatConfirmState>((set, get) => ({
	pending: null,
	request: (req) =>
		new Promise<boolean>((resolve) => {
			const prior = get().pending;
			if (prior) prior.resolve(false);
			set({ pending: { ...req, resolve } });
		}),
	settle: (approved) => {
		const pending = get().pending;
		if (!pending) return;
		pending.resolve(approved);
		set({ pending: null });
	},
}));
