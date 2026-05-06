import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneStore } from './pane-store';
import { MAX_CLOSED_HISTORY } from './pane-persistence';
import { makeLeaf } from './pane-reducer';

beforeEach(() => {
  // Reset store to a clean single-leaf tree before each test.
  const root = makeLeaf({ kind: 'route', path: '/test' });
  usePaneStore.getState().hydrate({
    root,
    focusedId: root.id,
    closedHistory: [],
  });
});

describe('closedHistory', () => {
  it('pushes the closed tab to history when closeActiveTab succeeds', () => {
    const store = usePaneStore.getState();
    store.addTab(store.focusedId, { kind: 'route', path: '/inbox' });
    // tabs = [/test, /inbox], active=1
    usePaneStore.getState().closeActiveTab();
    const history = usePaneStore.getState().closedHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ kind: 'route', path: '/inbox' });
  });

  it('caps history at MAX_CLOSED_HISTORY entries', () => {
    const store = usePaneStore.getState();
    for (let i = 0; i < MAX_CLOSED_HISTORY + 5; i++) {
      store.addTab(store.focusedId, { kind: 'route', path: `/r${i}` });
      usePaneStore.getState().closeActiveTab();
    }
    expect(usePaneStore.getState().closedHistory).toHaveLength(MAX_CLOSED_HISTORY);
    // Oldest entries dropped — first element should be /r5 (index 5 of 0..14).
    expect(
      (usePaneStore.getState().closedHistory[0] as { path: string }).path,
    ).toBe('/r5');
  });

  it('pushes every tab from a closed pane', () => {
    const store = usePaneStore.getState();
    // Make a second pane with two tabs, then close it.
    store.splitFocused('horizontal');
    const newPaneId = usePaneStore.getState().focusedId;
    store.addTab(newPaneId, { kind: 'route', path: '/a' });
    store.addTab(newPaneId, { kind: 'route', path: '/b' });
    // pane has [/test, /a, /b]
    usePaneStore.getState().closeFocusedPane();
    const history = usePaneStore.getState().closedHistory;
    // All three pushed, last-in-stack is /b.
    expect(history).toHaveLength(3);
    expect(history.map((v) => (v as { path?: string }).path)).toEqual([
      '/test',
      '/a',
      '/b',
    ]);
  });
});

describe('reopenLastClosed', () => {
  it('pops the last entry and adds it as a tab in the focused pane', () => {
    const store = usePaneStore.getState();
    store.addTab(store.focusedId, { kind: 'route', path: '/inbox' });
    usePaneStore.getState().closeActiveTab();
    expect(usePaneStore.getState().closedHistory).toHaveLength(1);

    usePaneStore.getState().reopenLastClosed();
    const state = usePaneStore.getState();
    expect(state.closedHistory).toHaveLength(0);
    const leaf = state.root as { tabs: { kind: string; path?: string }[] };
    expect(leaf.tabs.some((t) => t.kind === 'route' && t.path === '/inbox')).toBe(
      true,
    );
  });

  it('is a no-op when history is empty', () => {
    const before = usePaneStore.getState().root;
    usePaneStore.getState().reopenLastClosed();
    expect(usePaneStore.getState().root).toBe(before);
    expect(usePaneStore.getState().closedHistory).toHaveLength(0);
  });
});

describe('addTab mini-app sequencing', () => {
  it('adds distinct mini-app tabs to the focused pane', () => {
    const store = usePaneStore.getState();
    const focusedId = store.focusedId;
    store.addTab(focusedId, { kind: 'mini-app', name: 'storyboard' });
    store.addTab(focusedId, { kind: 'mini-app', name: 'hyperframes' });
    store.addTab(focusedId, { kind: 'mini-app', name: 'video-engine' });

    const root = usePaneStore.getState().root;
    if (root.type !== 'leaf') throw new Error('expected single leaf');
    const names = root.tabs
      .filter((t) => t.kind === 'mini-app')
      .map((t) => (t as Extract<typeof t, { kind: 'mini-app' }>).name);
    expect(names).toEqual(['storyboard', 'hyperframes', 'video-engine']);
  });

  it('falls back to the focused pane if leafId is stale', () => {
    // Reproduce: caller passed a stale leafId (e.g., focusedId snapshot from
    // before a split/close). addTab should still land somewhere visible
    // rather than silently no-oping.
    const store = usePaneStore.getState();
    const realFocusedId = store.focusedId;
    const stale = 'leaf-does-not-exist';
    store.addTab(stale, { kind: 'mini-app', name: 'video-engine' });

    const root = usePaneStore.getState().root;
    if (root.type !== 'leaf') throw new Error('expected single leaf');
    expect(root.id).toBe(realFocusedId);
    const hasVideoEngine = root.tabs.some(
      (t) => t.kind === 'mini-app' && t.name === 'video-engine',
    );
    expect(hasVideoEngine).toBe(true);
  });
});

describe('hydrate', () => {
  it('replaces root, focusedId, and closedHistory atomically', () => {
    const newRoot = makeLeaf({ kind: 'route', path: '/replaced' });
    usePaneStore.getState().hydrate({
      root: newRoot,
      focusedId: newRoot.id,
      closedHistory: [{ kind: 'route', path: '/closed-once' }],
    });
    const state = usePaneStore.getState();
    expect(state.root).toBe(newRoot);
    expect(state.focusedId).toBe(newRoot.id);
    expect(state.closedHistory).toEqual([{ kind: 'route', path: '/closed-once' }]);
  });
});
