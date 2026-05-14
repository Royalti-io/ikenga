// Files explorer state — survives mode switches (Zustand) and full reload
// (SQLite via layout-state). Children listings are owned by TanStack Query
// keyed by path; this store only persists what the FS itself can't tell us:
// which folders the user has expanded, which file is selected, and where
// the tree was scrolled.

import { create } from 'zustand';
import {
	debounce,
	deleteScopedLayoutState,
	migrateLegacyKey,
	saveScopedLayoutState,
} from '@/lib/layout-state';

export const STORAGE_KEY = 'files.explorer.v1';

interface Persisted {
	expanded: string[];
	selectedPath: string | null;
	scrollTop: number;
	showHidden: boolean;
	showIgnored: boolean;
}

interface FilesState {
	expanded: Set<string>;
	selectedPath: string | null;
	scrollTop: number;
	/** Show dotfile-prefixed entries (e.g. `.git`, `.next`, `.env`). Default off. */
	showHidden: boolean;
	/** Show heavy-ignored directories (`node_modules`, `target`, `dist`, etc.).
	 * Lazy expansion still applies — toggling this on does NOT auto-expand the
	 * dirs, so it stays cheap until the user clicks one. Default off. */
	showIgnored: boolean;
	hydrated: boolean;
	/** Project id of the currently-hydrated snapshot, or null pre-hydrate. */
	hydratedProjectId: string | null;
	hydrate: (projectId: string) => Promise<void>;
	/** Replace state from a saved snapshot (used by the project-layout-swap
	 *  orchestrator). Marks the store as hydrated for the new project. */
	applySnapshot: (projectId: string, data: Persisted) => void;
	/** Capture the current state as a plain `Persisted` object for the swap
	 *  orchestrator to save under the outgoing project's key. */
	snapshot: () => Persisted;
	toggle: (path: string) => void;
	expand: (path: string) => void;
	collapse: (path: string) => void;
	setSelected: (path: string | null) => void;
	setScrollTop: (n: number) => void;
	setShowHidden: (b: boolean) => void;
	setShowIgnored: (b: boolean) => void;
	toggleShowHidden: () => void;
	toggleShowIgnored: () => void;
	/** Drop paths from the expanded set (used after rename/trash/missing). */
	prune: (paths: string[]) => void;
}

const persist = debounce((projectId: string, data: Persisted) => {
	void saveScopedLayoutState(STORAGE_KEY, projectId, data);
}, 250);

/** Flush + force-save the current files-store state under `projectId`.
 *  Used by the project-layout-swap orchestrator before switching. */
export async function saveFilesStoreNow(
	projectId: string,
	data: Persisted
): Promise<void> {
	persist.flush();
	await saveScopedLayoutState(STORAGE_KEY, projectId, data);
}

export function flushFilesStorePersist(): void {
	persist.flush();
}

export async function resetFilesStore(projectId: string): Promise<void> {
	await deleteScopedLayoutState(STORAGE_KEY, projectId);
}

/** Read a project's persisted files-explorer snapshot without applying
 *  it to the live store. Used by the project-layout-swap orchestrator
 *  to pre-fetch the incoming project's state before the atomic swap. */
export async function loadFilesStateFor(projectId: string): Promise<Persisted> {
	return migrateLegacyKey<Persisted>(STORAGE_KEY, projectId, EMPTY_PERSISTED);
}

export type FilesPersisted = Persisted;

function snapshotOf(s: FilesState): Persisted {
	return {
		expanded: [...s.expanded],
		selectedPath: s.selectedPath,
		scrollTop: s.scrollTop,
		showHidden: s.showHidden,
		showIgnored: s.showIgnored,
	};
}

const EMPTY_PERSISTED: Persisted = {
	expanded: [],
	selectedPath: null,
	scrollTop: 0,
	showHidden: false,
	showIgnored: false,
};

function persistedFromState(s: Pick<FilesState,
	'expanded' | 'selectedPath' | 'scrollTop' | 'showHidden' | 'showIgnored'
>): Persisted {
	return snapshotOf(s as FilesState);
}

function projectIdFromStore(get: () => FilesState): string | null {
	return get().hydratedProjectId;
}

function persistCurrent(get: () => FilesState): void {
	const pid = projectIdFromStore(get);
	if (!pid) return;
	persist(pid, persistedFromState(get()));
}

export const useFilesStore = create<FilesState>((set, get) => ({
	expanded: new Set<string>(),
	selectedPath: null,
	scrollTop: 0,
	showHidden: false,
	showIgnored: false,
	hydrated: false,
	hydratedProjectId: null,

	hydrate: async (projectId: string) => {
		if (get().hydrated && get().hydratedProjectId === projectId) return;
		const data = await migrateLegacyKey<Persisted>(STORAGE_KEY, projectId, EMPTY_PERSISTED);
		set({
			expanded: new Set(data.expanded ?? []),
			selectedPath: data.selectedPath ?? null,
			scrollTop: data.scrollTop ?? 0,
			showHidden: data.showHidden ?? false,
			showIgnored: data.showIgnored ?? false,
			hydrated: true,
			hydratedProjectId: projectId,
		});
	},

	applySnapshot: (projectId, data) => {
		set({
			expanded: new Set(data.expanded ?? []),
			selectedPath: data.selectedPath ?? null,
			scrollTop: data.scrollTop ?? 0,
			showHidden: data.showHidden ?? false,
			showIgnored: data.showIgnored ?? false,
			hydrated: true,
			hydratedProjectId: projectId,
		});
	},

	snapshot: () => persistedFromState(get()),

	toggle: (path) => {
		const next = new Set(get().expanded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		set({ expanded: next });
		persistCurrent(get);
	},

	expand: (path) => {
		if (get().expanded.has(path)) return;
		const next = new Set(get().expanded);
		next.add(path);
		set({ expanded: next });
		persistCurrent(get);
	},

	collapse: (path) => {
		if (!get().expanded.has(path)) return;
		const next = new Set(get().expanded);
		next.delete(path);
		set({ expanded: next });
		persistCurrent(get);
	},

	setSelected: (selectedPath) => {
		set({ selectedPath });
		persistCurrent(get);
	},

	setScrollTop: (scrollTop) => {
		set({ scrollTop });
		persistCurrent(get);
	},

	setShowHidden: (showHidden) => {
		if (get().showHidden === showHidden) return;
		set({ showHidden });
		persistCurrent(get);
	},

	setShowIgnored: (showIgnored) => {
		if (get().showIgnored === showIgnored) return;
		set({ showIgnored });
		persistCurrent(get);
	},

	toggleShowHidden: () => {
		set({ showHidden: !get().showHidden });
		persistCurrent(get);
	},

	toggleShowIgnored: () => {
		set({ showIgnored: !get().showIgnored });
		persistCurrent(get);
	},

	prune: (paths) => {
		const cur = get().expanded;
		let changed = false;
		const next = new Set(cur);
		for (const p of paths) {
			if (next.delete(p)) changed = true;
			// also prune descendants — if `p` was a directory, anything under it
			// is now stale.
			const prefix = p.endsWith('/') ? p : `${p}/`;
			for (const e of cur) {
				if (e.startsWith(prefix) && next.delete(e)) changed = true;
			}
		}
		if (!changed) return;
		set({ expanded: next });
		persistCurrent(get);
	},
}));
