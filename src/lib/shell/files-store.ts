// Files explorer state — survives mode switches (Zustand) and full reload
// (SQLite via layout-state). Children listings are owned by TanStack Query
// keyed by path; this store only persists what the FS itself can't tell us:
// which folders the user has expanded, which file is selected, and where
// the tree was scrolled.

import { create } from 'zustand';
import {
	debounce,
	loadLayoutState,
	saveLayoutState,
} from '@/lib/layout-state';

export const STORAGE_KEY = 'files.explorer.v1';

interface Persisted {
	expanded: string[];
	selectedPath: string | null;
	scrollTop: number;
	showHidden: boolean;
	showIgnored: boolean;
	/** Root paths whose section is collapsed in the Files pane. Absent or empty
	 *  means all roots are expanded (the default). */
	rootsCollapsed?: string[];
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
	/** Per-root search query. Transient — not persisted. Empty/missing means
	 *  no filter is active for that root. */
	queries: Record<string, string>;
	/** Root sections whose tree+search is collapsed. Persisted. */
	rootsCollapsed: Set<string>;
	hydrated: boolean;
	hydrate: () => Promise<void>;
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
	setQuery: (rootPath: string, query: string) => void;
	toggleRootCollapsed: (rootPath: string) => void;
	/** Drop paths from the expanded set (used after rename/trash/missing). */
	prune: (paths: string[]) => void;
}

const persist = debounce((data: Persisted) => {
	void saveLayoutState(STORAGE_KEY, data);
}, 250);

export type FilesPersisted = Persisted;

function snapshotOf(s: FilesState): Persisted {
	return {
		expanded: [...s.expanded],
		selectedPath: s.selectedPath,
		scrollTop: s.scrollTop,
		showHidden: s.showHidden,
		showIgnored: s.showIgnored,
		rootsCollapsed: [...s.rootsCollapsed],
	};
}

const EMPTY_PERSISTED: Persisted = {
	expanded: [],
	selectedPath: null,
	scrollTop: 0,
	showHidden: false,
	showIgnored: false,
	rootsCollapsed: [],
};

function persistedFromState(s: Pick<FilesState,
	'expanded' | 'selectedPath' | 'scrollTop' | 'showHidden' | 'showIgnored' | 'rootsCollapsed'
>): Persisted {
	return snapshotOf(s as FilesState);
}

function persistCurrent(get: () => FilesState): void {
	if (!get().hydrated) return;
	persist(persistedFromState(get()));
}

export const useFilesStore = create<FilesState>((set, get) => ({
	expanded: new Set<string>(),
	selectedPath: null,
	scrollTop: 0,
	showHidden: false,
	showIgnored: false,
	queries: {},
	rootsCollapsed: new Set<string>(),
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		const data = await loadLayoutState<Persisted>(STORAGE_KEY, EMPTY_PERSISTED);
		set({
			expanded: new Set(data.expanded ?? []),
			selectedPath: data.selectedPath ?? null,
			scrollTop: data.scrollTop ?? 0,
			showHidden: data.showHidden ?? false,
			showIgnored: data.showIgnored ?? false,
			queries: {},
			rootsCollapsed: new Set(data.rootsCollapsed ?? []),
			hydrated: true,
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

	setQuery: (rootPath, query) => {
		const cur = get().queries;
		if ((cur[rootPath] ?? '') === query) return;
		const next = { ...cur };
		if (query === '') delete next[rootPath];
		else next[rootPath] = query;
		set({ queries: next });
	},

	toggleRootCollapsed: (rootPath) => {
		const next = new Set(get().rootsCollapsed);
		if (next.has(rootPath)) next.delete(rootPath);
		else next.add(rootPath);
		set({ rootsCollapsed: next });
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
