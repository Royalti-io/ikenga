import { create } from 'zustand';
import {
  type PaneDirection,
  type PaneId,
  type PaneNode,
  type PaneView,
  MAX_LEAVES,
} from './types';
import {
  addTab,
  closeLeaf,
  closeTab,
  findLeaf,
  getLeafIdsInOrder,
  leafCount,
  makeLeaf,
  moveTab,
  navigateFocused,
  reorderTab,
  setSplitSizes,
  setTabPinned,
  splitLeaf,
  splitLeafAt,
  switchTab,
  type MoveTabMode,
} from './pane-reducer';
import { MAX_CLOSED_HISTORY, type PaneTreeSnapshot } from './pane-persistence';

interface PaneStoreState {
  root: PaneNode;
  focusedId: PaneId;
  /** Stack of recently-closed views; top of stack = most recent. */
  closedHistory: PaneView[];
  /** Per-pane refresh counter. Bumping it forces the pane's content to
   * re-mount via React `key`. Not persisted — restarts from 0 on reload. */
  refreshTicks: Record<PaneId, number>;

  splitFocused: (direction: PaneDirection) => void;
  splitPane: (id: PaneId, direction: PaneDirection) => void;
  closePane: (id: PaneId) => void;
  closeFocusedPane: () => void;
  focusPane: (id: PaneId) => void;
  focusByIndex: (idx: number) => void;
  addTab: (id: PaneId, view: PaneView) => void;
  /** Same as addTab but does not switch focus to the new tab. */
  addTabBackground: (id: PaneId, view: PaneView) => void;
  closeTab: (id: PaneId, tabIdx: number) => void;
  closeActiveTab: () => void;
  switchTab: (id: PaneId, tabIdx: number) => void;
  setTabPinned: (id: PaneId, tabIdx: number, pinned: boolean) => void;
  toggleTabPinned: (id: PaneId, tabIdx: number) => void;
  navigateFocused: (path: string) => void;
  setSplitSizes: (path: number[], sizes: number[]) => void;
  moveTab: (
    srcLeafId: PaneId,
    srcTabIdx: number,
    dstLeafId: PaneId,
    mode: MoveTabMode,
  ) => void;
  /** Reorder a tab within the same leaf. */
  reorderTab: (leafId: PaneId, fromIdx: number, toIdx: number) => void;
  /**
   * Place an externally-sourced view into the pane tree (e.g., from the
   * Dock). `'append'` adds it as a tab; edge modes split the dst pane and
   * place the view in the new sibling leaf. Returns true on success so the
   * caller can decide whether to remove the view from its source.
   */
  placeView: (dstLeafId: PaneId, view: PaneView, mode: MoveTabMode) => boolean;

  /** Pop the most-recently-closed view and add it as a tab in the focused pane. */
  reopenLastClosed: () => void;
  /** Bump the refresh tick for a pane (focused if omitted). Re-mounts content. */
  refreshPane: (paneId?: PaneId) => void;
  /** Replace the entire store from a persisted snapshot. Workspace mount only. */
  hydrate: (snapshot: PaneTreeSnapshot) => void;

  // Derived helpers — fine to expose, callers use them in render.
  leafCount: () => number;
  canSplit: () => boolean;
  leafIdsInOrder: () => PaneId[];
  focusedView: () => PaneView | null;
}

function initialState(): { root: PaneNode; focusedId: PaneId } {
  const initialPath =
    typeof window !== 'undefined' ? window.location.pathname || '/' : '/';
  const root = makeLeaf({ kind: 'route', path: initialPath });
  return { root, focusedId: root.id };
}

function viewsMatch(a: PaneView, b: PaneView): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'route':
      return a.path === (b as Extract<PaneView, { kind: 'route' }>).path;
    case 'terminal':
      return a.sessionId === (b as Extract<PaneView, { kind: 'terminal' }>).sessionId;
    case 'chat':
      return a.sessionId === (b as Extract<PaneView, { kind: 'chat' }>).sessionId;
    case 'artifact':
      return a.path === (b as Extract<PaneView, { kind: 'artifact' }>).path;
  }
}

function findExistingTab(
  root: PaneNode,
  leafId: PaneId,
  view: PaneView,
): number {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return -1;
  return leaf.tabs.findIndex((t) => viewsMatch(t, view));
}

/**
 * Search every leaf in the tree for a tab matching `view`. Returns the first
 * hit (deterministic order via getLeafIdsInOrder), or null if none found.
 * Used to dedup across panes — clicking a file/route already open in *any*
 * pane should focus that tab instead of creating a duplicate elsewhere.
 */
function findExistingTabAnywhere(
  root: PaneNode,
  view: PaneView,
): { leafId: PaneId; tabIdx: number } | null {
  for (const id of getLeafIdsInOrder(root)) {
    const leaf = findLeaf(root, id);
    if (!leaf) continue;
    const idx = leaf.tabs.findIndex((t) => viewsMatch(t, view));
    if (idx >= 0) return { leafId: id, tabIdx: idx };
  }
  return null;
}

function pushClosed(stack: PaneView[], views: PaneView[]): PaneView[] {
  const next = [...stack, ...views];
  return next.length > MAX_CLOSED_HISTORY
    ? next.slice(next.length - MAX_CLOSED_HISTORY)
    : next;
}

export const usePaneStore = create<PaneStoreState>((set, get) => ({
  ...initialState(),
  closedHistory: [],
  refreshTicks: {},

  splitFocused: (direction) => {
    const { root, focusedId } = get();
    const r = splitLeaf(root, focusedId, direction);
    if (!r.ok || !r.newLeafId) return;
    set({ root: r.root, focusedId: r.newLeafId });
  },

  splitPane: (id, direction) => {
    const { root } = get();
    const r = splitLeaf(root, id, direction);
    if (!r.ok || !r.newLeafId) return;
    set({ root: r.root, focusedId: r.newLeafId });
  },

  closePane: (id) => {
    const { root, focusedId, closedHistory } = get();
    const leaf = findLeaf(root, id);
    const r = closeLeaf(root, id, focusedId);
    if (!r.ok) return;
    set({
      root: r.root,
      focusedId: r.focusedId,
      closedHistory: leaf ? pushClosed(closedHistory, leaf.tabs) : closedHistory,
    });
  },

  closeFocusedPane: () => {
    const { root, focusedId, closedHistory } = get();
    const leaf = findLeaf(root, focusedId);
    const r = closeLeaf(root, focusedId, focusedId);
    if (!r.ok) return;
    set({
      root: r.root,
      focusedId: r.focusedId,
      closedHistory: leaf ? pushClosed(closedHistory, leaf.tabs) : closedHistory,
    });
  },

  focusPane: (id) => {
    const { root } = get();
    if (!findLeaf(root, id)) return;
    set({ focusedId: id });
  },

  focusByIndex: (idx) => {
    const ids = getLeafIdsInOrder(get().root);
    if (idx < 0 || idx >= ids.length) return;
    set({ focusedId: ids[idx] });
  },

  addTab: (id, view) => {
    const { root, focusedId } = get();
    // Resolve to a real leaf. Callers occasionally pass a stale id captured
    // in a closure from before a split/close — without this fallback the
    // reducer's leafId match silently no-ops and the click vanishes.
    const targetId = findLeaf(root, id)
      ? id
      : findLeaf(root, focusedId)
        ? focusedId
        : (getLeafIdsInOrder(root)[0] ?? id);

    // Prefer the same pane: if it's already there, just switch to it.
    const sameLeaf = findExistingTab(root, targetId, view);
    if (sameLeaf >= 0) {
      set({ root: switchTab(root, targetId, sameLeaf) });
      return;
    }
    // Otherwise, look across all panes — focus the pane that already holds
    // it instead of duplicating.
    const elsewhere = findExistingTabAnywhere(root, view);
    if (elsewhere) {
      set({
        root: switchTab(root, elsewhere.leafId, elsewhere.tabIdx),
        focusedId: elsewhere.leafId,
      });
      return;
    }
    set({ root: addTab(root, targetId, view) });
  },

  addTabBackground: (id, view) => {
    const { root } = get();
    if (findExistingTab(root, id, view) >= 0) return;
    if (findExistingTabAnywhere(root, view)) return;
    const leafBefore = findLeaf(root, id);
    const prevActive = leafBefore?.activeTabIdx ?? 0;
    const next = addTab(root, id, view);
    set({ root: switchTab(next, id, prevActive) });
  },

  closeTab: (id, tabIdx) => {
    const { root, focusedId, closedHistory } = get();
    const leaf = findLeaf(root, id);
    const closingView = leaf?.tabs[tabIdx];
    const r = closeTab(root, id, tabIdx, focusedId);
    if (!r.ok) return;
    set({
      root: r.root,
      focusedId: r.focusedId,
      closedHistory: closingView
        ? pushClosed(closedHistory, [closingView])
        : closedHistory,
    });
  },

  closeActiveTab: () => {
    const { root, focusedId, closedHistory } = get();
    const leaf = findLeaf(root, focusedId);
    if (!leaf) return;
    const closingView = leaf.tabs[leaf.activeTabIdx];
    const r = closeTab(root, focusedId, leaf.activeTabIdx, focusedId);
    if (!r.ok) return;
    set({
      root: r.root,
      focusedId: r.focusedId,
      closedHistory: closingView
        ? pushClosed(closedHistory, [closingView])
        : closedHistory,
    });
  },

  switchTab: (id, tabIdx) => {
    set({ root: switchTab(get().root, id, tabIdx) });
  },

  setTabPinned: (id, tabIdx, pinned) => {
    set({ root: setTabPinned(get().root, id, tabIdx, pinned) });
  },

  toggleTabPinned: (id, tabIdx) => {
    const leaf = findLeaf(get().root, id);
    if (!leaf) return;
    const tab = leaf.tabs[tabIdx];
    if (!tab) return;
    set({ root: setTabPinned(get().root, id, tabIdx, !tab.pinned) });
  },

  navigateFocused: (path) => {
    const { root, focusedId } = get();
    set({ root: navigateFocused(root, focusedId, path) });
  },

  setSplitSizes: (path, sizes) => {
    set({ root: setSplitSizes(get().root, path, sizes) });
  },

  moveTab: (srcLeafId, srcTabIdx, dstLeafId, mode) => {
    const { root, focusedId } = get();
    const r = moveTab(root, srcLeafId, srcTabIdx, dstLeafId, mode, focusedId);
    if (!r.ok) return;
    set({ root: r.root, focusedId: r.focusedId });
  },

  reorderTab: (leafId, fromIdx, toIdx) => {
    set({ root: reorderTab(get().root, leafId, fromIdx, toIdx) });
  },

  placeView: (dstLeafId, view, mode) => {
    const { root } = get();
    if (!findLeaf(root, dstLeafId)) return false;
    if (mode === 'append') {
      const sameLeaf = findExistingTab(root, dstLeafId, view);
      if (sameLeaf >= 0) {
        set({ root: switchTab(root, dstLeafId, sameLeaf), focusedId: dstLeafId });
        return true;
      }
      const elsewhere = findExistingTabAnywhere(root, view);
      if (elsewhere) {
        set({
          root: switchTab(root, elsewhere.leafId, elsewhere.tabIdx),
          focusedId: elsewhere.leafId,
        });
        return true;
      }
      set({ root: addTab(root, dstLeafId, view), focusedId: dstLeafId });
      return true;
    }
    const direction = mode === 'left' || mode === 'right' ? 'horizontal' : 'vertical';
    const position = mode === 'left' || mode === 'top' ? 'before' : 'after';
    const r = splitLeafAt(root, dstLeafId, direction, view, position);
    if (!r.ok || !r.newLeafId) return false;
    set({ root: r.root, focusedId: r.newLeafId });
    return true;
  },

  reopenLastClosed: () => {
    const { closedHistory, focusedId, root } = get();
    if (closedHistory.length === 0) return;
    const view = closedHistory[closedHistory.length - 1];
    const remaining = closedHistory.slice(0, -1);
    set({
      root: addTab(root, focusedId, view),
      closedHistory: remaining,
    });
  },

  hydrate: (snapshot) => {
    set({
      root: snapshot.root,
      focusedId: snapshot.focusedId,
      closedHistory: snapshot.closedHistory,
    });
  },

  refreshPane: (paneId) => {
    const id = paneId ?? get().focusedId;
    if (!id) return;
    const ticks = get().refreshTicks;
    set({ refreshTicks: { ...ticks, [id]: (ticks[id] ?? 0) + 1 } });
  },

  leafCount: () => leafCount(get().root),
  canSplit: () => leafCount(get().root) < MAX_LEAVES,
  leafIdsInOrder: () => getLeafIdsInOrder(get().root),
  focusedView: () => {
    const { root, focusedId } = get();
    const leaf = findLeaf(root, focusedId);
    return leaf ? leaf.tabs[leaf.activeTabIdx] : null;
  },
}));
