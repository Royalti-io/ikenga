import { describe, expect, it } from 'vitest';
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
  setSplitSizes,
  splitLeaf,
  splitLeafAt,
  switchTab,
} from './pane-reducer';
import { MAX_LEAVES, type LeafNode, type PaneNode, type SplitNode } from './types';

function newRoute(path: string): LeafNode {
  return makeLeaf({ kind: 'route', path });
}

function leafIds(root: PaneNode): string[] {
  return getLeafIdsInOrder(root);
}

describe('splitLeaf', () => {
  it('wraps the root leaf in a split when there is no parent', () => {
    const root = newRoute('/inbox');
    const r = splitLeaf(root, root.id, 'horizontal');
    expect(r.ok).toBe(true);
    expect(r.root.type).toBe('split');
    const split = r.root as SplitNode;
    expect(split.direction).toBe('horizontal');
    expect(split.children).toHaveLength(2);
    expect(split.sizes).toEqual([50, 50]);
  });

  it('flattens consecutive splits in the same direction (3-leaf row)', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const ids1 = leafIds(r1.root);
    const r2 = splitLeaf(r1.root, ids1[0], 'horizontal');
    expect(r2.ok).toBe(true);
    expect(r2.root.type).toBe('split');
    const split = r2.root as SplitNode;
    expect(split.children.every((c) => c.type === 'leaf')).toBe(true);
    expect(split.children).toHaveLength(3);
    expect(split.sizes).toEqual([33, 33, 34]);
  });

  it('nests when splitting orthogonally inside a leaf', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const ids1 = leafIds(r1.root);
    const r2 = splitLeaf(r1.root, ids1[0], 'vertical');
    expect(r2.ok).toBe(true);
    const split = r2.root as SplitNode;
    expect(split.direction).toBe('horizontal');
    // First child should now be a vertical split, second still a leaf.
    expect(split.children[0].type).toBe('split');
    expect((split.children[0] as SplitNode).direction).toBe('vertical');
    expect(split.children[1].type).toBe('leaf');
  });

  it('refuses to split past the 6-leaf cap', () => {
    let root: PaneNode = newRoute('/a');
    for (let i = 0; i < 5; i++) {
      const ids = leafIds(root);
      const r = splitLeaf(root, ids[0], 'horizontal');
      expect(r.ok).toBe(true);
      root = r.root;
    }
    expect(leafCount(root)).toBe(6);
    const ids = leafIds(root);
    const blocked = splitLeaf(root, ids[0], 'horizontal');
    expect(blocked.ok).toBe(false);
    expect(leafCount(blocked.root)).toBe(6);
  });

  it('duplicates the active tab into the new sibling', () => {
    const leaf = makeLeaf({ kind: 'route', path: '/inbox' });
    const withSecondTab = addTab(leaf, leaf.id, { kind: 'route', path: '/finance' });
    const switched = switchTab(withSecondTab, leaf.id, 1);
    const r = splitLeaf(switched, leaf.id, 'horizontal');
    expect(r.ok).toBe(true);
    const split = r.root as SplitNode;
    const newLeaf = split.children.find(
      (c) => c.type === 'leaf' && c.id !== leaf.id,
    ) as LeafNode;
    expect(newLeaf.tabs).toHaveLength(1);
    expect(newLeaf.tabs[0]).toEqual({ kind: 'route', path: '/finance' });
  });
});

describe('closeLeaf', () => {
  it('removes a middle leaf and redistributes sizes', () => {
    let root: PaneNode = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const r2 = splitLeaf(r1.root, leafIds(r1.root)[0], 'horizontal');
    root = r2.root;
    const ids = leafIds(root);
    const middleId = ids[1];
    const r = closeLeaf(root, middleId, ids[0]);
    expect(r.ok).toBe(true);
    expect(leafCount(r.root)).toBe(2);
    const split = r.root as SplitNode;
    expect(split.children).toHaveLength(2);
    expect(split.sizes).toEqual([50, 50]);
  });

  it('collapses the parent split when closing leaves it with one child', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const ids = leafIds(r1.root);
    const r = closeLeaf(r1.root, ids[1], ids[0]);
    expect(r.ok).toBe(true);
    expect(r.root.type).toBe('leaf');
    expect(leafCount(r.root)).toBe(1);
  });

  it('moves focus to DFS-prev when closing the focused leaf', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, root.id, 'horizontal').root;
    root = splitLeaf(root, leafIds(root)[0], 'horizontal').root;
    const ids = leafIds(root);
    // Close the middle leaf while it's focused.
    const r = closeLeaf(root, ids[1], ids[1]);
    expect(r.ok).toBe(true);
    // DFS-prev of index 1 is index 0.
    expect(r.focusedId).toBe(ids[0]);
  });

  it('falls back to DFS-next when closing the first focused leaf', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, root.id, 'horizontal').root;
    const ids = leafIds(root);
    const r = closeLeaf(root, ids[0], ids[0]);
    expect(r.ok).toBe(true);
    // After collapse, only one leaf remains; focus is on it.
    expect(leafCount(r.root)).toBe(1);
    expect((r.root as LeafNode).id).toBe(ids[1]);
    expect(r.focusedId).toBe(ids[1]);
  });

  it('refuses to close the last leaf in the tree', () => {
    const root = newRoute('/a');
    const r = closeLeaf(root, root.id, root.id);
    expect(r.ok).toBe(false);
    expect(leafCount(r.root)).toBe(1);
  });

  it('preserves focus when closing a non-focused leaf', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const ids = leafIds(r1.root);
    const r = closeLeaf(r1.root, ids[1], ids[0]);
    expect(r.ok).toBe(true);
    expect(r.focusedId).toBe(ids[0]);
  });
});

describe('tabs', () => {
  it('addTab appends and switches to the new tab', () => {
    const leaf = newRoute('/a');
    const r = addTab(leaf, leaf.id, { kind: 'route', path: '/b' });
    const updated = findLeaf(r, leaf.id)!;
    expect(updated.tabs).toHaveLength(2);
    expect(updated.activeTabIdx).toBe(1);
  });

  it('switchTab updates the active index', () => {
    let root: PaneNode = newRoute('/a');
    root = addTab(root, (root as LeafNode).id, { kind: 'route', path: '/b' });
    root = switchTab(root, (root as LeafNode).id, 0);
    expect((root as LeafNode).activeTabIdx).toBe(0);
  });

  it('closeTab removes a non-active tab and adjusts active index', () => {
    let root: PaneNode = newRoute('/a');
    const id = (root as LeafNode).id;
    root = addTab(root, id, { kind: 'route', path: '/b' });
    root = addTab(root, id, { kind: 'route', path: '/c' });
    // tabs: [/a, /b, /c], active=2 (last add)
    const r = closeTab(root, id, 0, id);
    expect(r.ok).toBe(true);
    expect(r.paneClosed).toBe(false);
    const leaf = findLeaf(r.root, id)!;
    expect(leaf.tabs.map((t) => (t as { path: string }).path)).toEqual(['/b', '/c']);
    expect(leaf.activeTabIdx).toBe(1); // shifted from 2 → 1
  });

  it('closeTab on the last tab closes the pane', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, (root as LeafNode).id, 'horizontal').root;
    const ids = leafIds(root);
    const r = closeTab(root, ids[1], 0, ids[1]);
    expect(r.ok).toBe(true);
    expect(r.paneClosed).toBe(true);
    expect(leafCount(r.root)).toBe(1);
  });

  it('closeTab on the last tab of the only pane is rejected', () => {
    const root = newRoute('/a');
    const r = closeTab(root, root.id, 0, root.id);
    expect(r.ok).toBe(false);
  });
});

describe('navigateFocused', () => {
  it('updates the active route tab path in the focused leaf', () => {
    const root = newRoute('/inbox');
    const r = navigateFocused(root, root.id, '/finance');
    const leaf = r as LeafNode;
    expect(leaf.tabs[0]).toEqual({ kind: 'route', path: '/finance' });
  });

  it('opens a new tab when active tab is not a route', () => {
    const leaf = makeLeaf({ kind: 'terminal', sessionId: 's1' });
    const r = navigateFocused(leaf, leaf.id, '/inbox');
    const updated = r as LeafNode;
    expect(updated.tabs).toHaveLength(2);
    expect(updated.activeTabIdx).toBe(1);
    expect(updated.tabs[1]).toEqual({ kind: 'route', path: '/inbox' });
  });

  it('only affects the focused leaf', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const ids = leafIds(r1.root);
    const r = navigateFocused(r1.root, ids[0], '/finance');
    const left = findLeaf(r, ids[0])! as LeafNode;
    const right = findLeaf(r, ids[1])! as LeafNode;
    expect((left.tabs[0] as { path: string }).path).toBe('/finance');
    expect((right.tabs[0] as { path: string }).path).toBe('/a');
  });
});

describe('splitLeafAt', () => {
  it('places the new leaf BEFORE the target with position=before', () => {
    const root = newRoute('/a');
    const r = splitLeafAt(root, root.id, 'horizontal', { kind: 'route', path: '/b' }, 'before');
    expect(r.ok).toBe(true);
    const split = r.root as SplitNode;
    // First child is the new leaf, second is the original.
    expect(split.children[0].type).toBe('leaf');
    expect((split.children[0] as LeafNode).id).toBe(r.newLeafId);
    expect((split.children[1] as LeafNode).id).toBe(root.id);
  });

  it('places the new leaf AFTER the target with position=after', () => {
    const root = newRoute('/a');
    const r = splitLeafAt(root, root.id, 'vertical', { kind: 'route', path: '/b' }, 'after');
    expect(r.ok).toBe(true);
    const split = r.root as SplitNode;
    expect((split.children[0] as LeafNode).id).toBe(root.id);
    expect((split.children[1] as LeafNode).id).toBe(r.newLeafId);
  });

  it('respects 6-leaf cap', () => {
    let root: PaneNode = newRoute('/a');
    for (let i = 0; i < MAX_LEAVES - 1; i++) {
      root = splitLeaf(root, leafIds(root)[0], 'horizontal').root;
    }
    expect(leafCount(root)).toBe(MAX_LEAVES);
    const blocked = splitLeafAt(
      root,
      leafIds(root)[0],
      'horizontal',
      { kind: 'route', path: '/n' },
      'before',
    );
    expect(blocked.ok).toBe(false);
  });
});

describe('moveTab', () => {
  it('moves a tab to a different pane in append mode', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, (root as LeafNode).id, 'horizontal').root;
    const ids = leafIds(root);
    // Add a second tab to ids[0] so it has something to move.
    root = addTab(root, ids[0], { kind: 'route', path: '/moved' });

    const r = moveTab(root, ids[0], 1, ids[1], 'append', ids[0]);
    expect(r.ok).toBe(true);
    expect(r.focusedId).toBe(ids[1]);
    const left = findLeaf(r.root, ids[0])!;
    const right = findLeaf(r.root, ids[1])!;
    expect(left.tabs).toHaveLength(1);
    expect(right.tabs).toHaveLength(2);
    expect((right.tabs[1] as { path: string }).path).toBe('/moved');
  });

  it('splits the dst pane and places the moved tab in the new sibling (right edge)', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, (root as LeafNode).id, 'horizontal').root;
    const ids = leafIds(root);
    root = addTab(root, ids[0], { kind: 'route', path: '/payload' });

    const r = moveTab(root, ids[0], 1, ids[1], 'right', ids[0]);
    expect(r.ok).toBe(true);
    // After the move, the tree has 3 leaves. The moved tab is in the
    // newly-created sibling to the RIGHT of ids[1].
    expect(leafCount(r.root)).toBe(3);
    const ordered = getLeafIdsInOrder(r.root);
    expect(ordered[0]).toBe(ids[0]); // original src on far left
    expect(ordered[1]).toBe(ids[1]); // dst stays in the middle
    const newId = ordered[2];
    expect(newId).toBe(r.focusedId);
    const newLeaf = findLeaf(r.root, newId)!;
    expect(newLeaf.tabs).toEqual([{ kind: 'route', path: '/payload' }]);
  });

  it('places to the left of dst on left-edge drop', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, (root as LeafNode).id, 'horizontal').root;
    const ids = leafIds(root);
    root = addTab(root, ids[1], { kind: 'route', path: '/payload' });

    const r = moveTab(root, ids[1], 1, ids[0], 'left', ids[1]);
    expect(r.ok).toBe(true);
    expect(leafCount(r.root)).toBe(3);
    const ordered = getLeafIdsInOrder(r.root);
    // New leaf goes to the LEFT of ids[0].
    expect(ordered[0]).toBe(r.focusedId);
    expect(ordered[1]).toBe(ids[0]);
    expect(ordered[2]).toBe(ids[1]);
  });

  it('refuses split-mode drops at the 6-leaf cap', () => {
    let root: PaneNode = newRoute('/a');
    for (let i = 0; i < MAX_LEAVES - 1; i++) {
      root = splitLeaf(root, leafIds(root)[0], 'horizontal').root;
    }
    expect(leafCount(root)).toBe(MAX_LEAVES);
    const ids = leafIds(root);
    // Give ids[0] a 2nd tab.
    root = addTab(root, ids[0], { kind: 'route', path: '/p' });

    const r = moveTab(root, ids[0], 1, ids[1], 'right', ids[0]);
    expect(r.ok).toBe(false);
    expect(leafCount(r.root)).toBe(MAX_LEAVES);
  });

  it('allows append-mode drops at the cap', () => {
    let root: PaneNode = newRoute('/a');
    for (let i = 0; i < MAX_LEAVES - 1; i++) {
      root = splitLeaf(root, leafIds(root)[0], 'horizontal').root;
    }
    const ids = leafIds(root);
    root = addTab(root, ids[0], { kind: 'route', path: '/p' });
    const r = moveTab(root, ids[0], 1, ids[1], 'append', ids[0]);
    expect(r.ok).toBe(true);
    expect(leafCount(r.root)).toBe(MAX_LEAVES); // no new pane
    const dst = findLeaf(r.root, ids[1])!;
    expect(dst.tabs).toHaveLength(2);
  });

  it('refuses same-pane single-tab move (would be no-op)', () => {
    const root = newRoute('/a');
    const r = moveTab(root, root.id, 0, root.id, 'append', root.id);
    expect(r.ok).toBe(false);
  });

  it('closes src pane when its last tab is moved away', () => {
    let root: PaneNode = newRoute('/a');
    root = splitLeaf(root, (root as LeafNode).id, 'horizontal').root;
    const ids = leafIds(root);
    // ids[0] has one tab. Move it to ids[1] → ids[0] should disappear.
    const r = moveTab(root, ids[0], 0, ids[1], 'append', ids[0]);
    expect(r.ok).toBe(true);
    expect(leafCount(r.root)).toBe(1);
    const surviving = r.root as LeafNode;
    expect(surviving.id).toBe(ids[1]);
    expect(surviving.tabs).toHaveLength(2);
  });
});

describe('setSplitSizes', () => {
  it('updates sizes at the root split', () => {
    const root = newRoute('/a');
    const r1 = splitLeaf(root, root.id, 'horizontal');
    const updated = setSplitSizes(r1.root, [], [70, 30]);
    expect((updated as SplitNode).sizes).toEqual([70, 30]);
  });
});
