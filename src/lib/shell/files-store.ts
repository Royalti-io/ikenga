// Files explorer state — survives mode switches (Zustand) and full reload
// (SQLite via layout-state). Children listings are owned by TanStack Query
// keyed by path; this store only persists what the FS itself can't tell us:
// which folders the user has expanded, which file is selected, and where
// the tree was scrolled.

import { create } from 'zustand';
import { debounce, loadLayoutState, saveLayoutState } from '@/lib/layout-state';

const STORAGE_KEY = 'files.explorer.v1';

interface Persisted {
  expanded: string[];
  selectedPath: string | null;
  scrollTop: number;
}

interface FilesState {
  expanded: Set<string>;
  selectedPath: string | null;
  scrollTop: number;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  setSelected: (path: string | null) => void;
  setScrollTop: (n: number) => void;
  /** Drop paths from the expanded set (used after rename/trash/missing). */
  prune: (paths: string[]) => void;
}

const persist = debounce((data: Persisted) => {
  void saveLayoutState(STORAGE_KEY, data);
}, 250);

function snapshot(s: FilesState): Persisted {
  return {
    expanded: [...s.expanded],
    selectedPath: s.selectedPath,
    scrollTop: s.scrollTop,
  };
}

export const useFilesStore = create<FilesState>((set, get) => ({
  expanded: new Set<string>(),
  selectedPath: null,
  scrollTop: 0,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const data = await loadLayoutState<Persisted>(STORAGE_KEY, {
      expanded: [],
      selectedPath: null,
      scrollTop: 0,
    });
    set({
      expanded: new Set(data.expanded ?? []),
      selectedPath: data.selectedPath ?? null,
      scrollTop: data.scrollTop ?? 0,
      hydrated: true,
    });
  },

  toggle: (path) => {
    const next = new Set(get().expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expanded: next });
    persist(snapshot(get()));
  },

  expand: (path) => {
    if (get().expanded.has(path)) return;
    const next = new Set(get().expanded);
    next.add(path);
    set({ expanded: next });
    persist(snapshot(get()));
  },

  collapse: (path) => {
    if (!get().expanded.has(path)) return;
    const next = new Set(get().expanded);
    next.delete(path);
    set({ expanded: next });
    persist(snapshot(get()));
  },

  setSelected: (selectedPath) => {
    set({ selectedPath });
    persist(snapshot(get()));
  },

  setScrollTop: (scrollTop) => {
    set({ scrollTop });
    persist(snapshot(get()));
  },

  prune: (paths) => {
    const cur = get().expanded;
    let changed = false;
    const next = new Set(cur);
    for (const p of paths) {
      if (next.delete(p)) changed = true;
      // also prune descendants — if `p` was a directory, anything under it
      // is now stale.
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const e of cur) {
        if (e.startsWith(prefix) && next.delete(e)) changed = true;
      }
    }
    if (!changed) return;
    set({ expanded: next });
    persist(snapshot(get()));
  },
}));
