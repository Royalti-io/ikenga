// Recently-opened folders for the artifact-grid sidebar — per project.
//
// Persisted to settings_kv as a JSON array under
// `artifact-grid.recents.<projectId>` (MRU-first, capped). The sidebar
// reads the active project's list; switching projects shows a different
// set. Subscribe channel is per-project so a switch live-refreshes.

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';

const KEY_PREFIX = 'artifact-grid.recents.';
const CAP = 8;

export interface RecentGridFolder {
	path: string;
	openedAtMs: number;
}

function key(projectId: string): string {
	return `${KEY_PREFIX}${projectId}`;
}

// ─── Reactive subscription ───────────────────────────────────────────────

type RecentsListener = (next: RecentGridFolder[]) => void;
const listeners: Map<string, Set<RecentsListener>> = new Map();

export function subscribeRecents(projectId: string, fn: RecentsListener): () => void {
	let set = listeners.get(projectId);
	if (!set) {
		set = new Set();
		listeners.set(projectId, set);
	}
	set.add(fn);
	return () => {
		set?.delete(fn);
		if (set && set.size === 0) listeners.delete(projectId);
	};
}

function fire(projectId: string, next: RecentGridFolder[]): void {
	const set = listeners.get(projectId);
	if (!set) return;
	for (const fn of set) {
		try {
			fn(next);
		} catch (e) {
			console.error('[artifact-grid-recents] listener threw', e);
		}
	}
}

// ─── Load / mutate ───────────────────────────────────────────────────────

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

export async function loadRecents(projectId: string): Promise<RecentGridFolder[]> {
	const raw = await settingsGet(key(projectId));
	return parse(raw);
}

/** Move `path` to the front of the recents list (deduplicating any prior
 *  entry for the same path), cap at CAP, and persist under the project's
 *  key. Returns the new list. */
export async function recordOpen(projectId: string, path: string): Promise<RecentGridFolder[]> {
	const cur = await loadRecents(projectId);
	const filtered = cur.filter((r) => r.path !== path);
	const next: RecentGridFolder[] = [{ path, openedAtMs: Date.now() }, ...filtered].slice(0, CAP);
	await settingsSet(key(projectId), JSON.stringify(next));
	fire(projectId, next);
	return next;
}

export async function removeRecent(projectId: string, path: string): Promise<RecentGridFolder[]> {
	const cur = await loadRecents(projectId);
	const next = cur.filter((r) => r.path !== path);
	await settingsSet(key(projectId), JSON.stringify(next));
	fire(projectId, next);
	return next;
}

/** Open `path` as an artifact-studio grid-density tab on the focused leaf
 *  and record the recent under the given project. Single shared entry
 *  point so every surface (sidebar Tools row, home browse, future ones)
 *  keeps the recents list in sync. */
export async function openArtifactGrid(projectId: string, path: string): Promise<void> {
	const { focusedId, addTab } = usePaneStore.getState();
	addTab(focusedId, { kind: 'artifact-studio', path, density: 'grid' });
	await recordOpen(projectId, path).catch((e) => {
		console.error('[artifact-grid-recents] recordOpen failed', e);
	});
}
