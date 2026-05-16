// Recently-opened folders for the artifact-grid quick-launcher.
//
// Persisted to settings_kv as a JSON array under
// `artifact-grid.recents` (MRU-first, capped). The activity-bar
// quick-launch popover reads this for its main list; the Tauri folder
// picker is the fall-through at the bottom.

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';

const KEY = 'artifact-grid.recents';
const CAP = 8;

export interface RecentGridFolder {
	path: string;
	openedAtMs: number;
}

function parse(raw: string | null): RecentGridFolder[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter(
				(x): x is RecentGridFolder =>
					x &&
					typeof x === 'object' &&
					typeof x.path === 'string' &&
					typeof x.openedAtMs === 'number'
			)
			.slice(0, CAP);
	} catch {
		return [];
	}
}

export async function loadRecents(): Promise<RecentGridFolder[]> {
	const raw = await settingsGet(KEY);
	return parse(raw);
}

/** Move `path` to the front of the recents list (deduplicating any prior
 *  entry for the same path), cap at CAP, and persist. Returns the new list
 *  so callers can update local state without a re-read. */
export async function recordOpen(path: string): Promise<RecentGridFolder[]> {
	const cur = await loadRecents();
	const filtered = cur.filter((r) => r.path !== path);
	const next: RecentGridFolder[] = [{ path, openedAtMs: Date.now() }, ...filtered].slice(0, CAP);
	await settingsSet(KEY, JSON.stringify(next));
	return next;
}

export async function removeRecent(path: string): Promise<RecentGridFolder[]> {
	const cur = await loadRecents();
	const next = cur.filter((r) => r.path !== path);
	await settingsSet(KEY, JSON.stringify(next));
	return next;
}

/** Open `path` as an artifact-grid tab in the focused leaf and record the
 *  recent. Single shared entry point so every surface (activity-bar
 *  quick-launcher, files-mode context menu, future ones) keeps the recents
 *  list in sync. */
export async function openArtifactGrid(path: string): Promise<void> {
	const { focusedId, addTab } = usePaneStore.getState();
	addTab(focusedId, { kind: 'artifact-grid', path });
	await recordOpen(path).catch((e) => {
		console.error('[artifact-grid-recents] recordOpen failed', e);
	});
}
