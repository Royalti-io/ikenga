// Pending "wrong file?" recovery records for the wizard.
//
// When the watcher fires via the fallback grace (not a slug-match), the
// loupe might be showing the wrong file — a stray sibling create that
// landed before the agent's actual file did. We post a record here; the
// `WizardPopRecoveryChip` mounted at workspace root reads it and renders
// a small dismissible chip with a one-click "open folder" action that
// swaps the loupe back to grid density.
//
// Slug-match fires (the common path) skip this store entirely — they're
// almost always the right file and the chip would be noise.
//
// Records auto-expire so a long-ignored chip doesn't linger.

import { create } from 'zustand';

export interface WizardPopRecord {
	/** Studio leaf id the loupe is mounted on. */
	paneId: string;
	/** Path the loupe opened on. */
	artifactPath: string;
	/** Folder the watcher was scoped to — what we'd swap back to. */
	folder: string;
	/** When the record was posted (ms). */
	postedAt: number;
}

interface PopState {
	pending: Record<string, WizardPopRecord>;
	post: (rec: WizardPopRecord) => void;
	dismiss: (paneId: string) => void;
}

export const useWizardPopStore = create<PopState>((set) => ({
	pending: {},
	post: (rec) =>
		set((s) => ({
			pending: { ...s.pending, [rec.paneId]: rec },
		})),
	dismiss: (paneId) =>
		set((s) => {
			if (!(paneId in s.pending)) return s;
			const { [paneId]: _drop, ...rest } = s.pending;
			return { pending: rest };
		}),
}));
