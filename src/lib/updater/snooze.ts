// Snooze state for the shell-update prompts.
//
// When the user dismisses the updater banner (or clicks "Defer 24h" on the
// About page), we silence the banner and de-emphasize the About-page card
// for 24h. The available update isn't hidden anywhere — the user can still
// initiate it from the About page or from the Packages mission-control
// tile. Snooze just silences the *nudges*.
//
// Persisted to localStorage so it survives reloads but not reinstalls.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const SNOOZE_MS = 24 * 60 * 60 * 1000; // 24h

interface UpdaterSnoozeState {
	/** Epoch ms until which nudges should stay silent. null = not snoozed. */
	snoozeUntil: number | null;
	/** Tag of the release the user snoozed against. New release → unsnooze. */
	snoozedVersion: string | null;
	snooze: (version: string) => void;
	clear: () => void;
	isSnoozed: (currentVersion: string | null) => boolean;
}

export const useUpdaterSnooze = create<UpdaterSnoozeState>()(
	persist(
		(set, get) => ({
			snoozeUntil: null,
			snoozedVersion: null,
			snooze: (version) => set({ snoozeUntil: Date.now() + SNOOZE_MS, snoozedVersion: version }),
			clear: () => set({ snoozeUntil: null, snoozedVersion: null }),
			isSnoozed: (currentVersion) => {
				const { snoozeUntil, snoozedVersion } = get();
				if (!snoozeUntil) return false;
				// A new release supersedes a previous snooze — don't silence a fresher version.
				if (currentVersion && currentVersion !== snoozedVersion) return false;
				return snoozeUntil > Date.now();
			},
		}),
		{ name: 'ikenga.updater-snooze' }
	)
);
