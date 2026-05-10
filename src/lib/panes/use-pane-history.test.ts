// Tests for usePaneHistory's underlying store actions. The hook itself is
// a thin reactive wrapper around `pushHistory`, `historyBack`,
// `historyForward`, and `replaceActiveViewAndPushHistory`; exercising those
// directly covers the logic without pulling in @testing-library/react
// (which isn't a dep of this project).

import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneStore } from './pane-store';
import { makeLeaf } from './pane-reducer';
import type { PaneView } from './types';

const ROUTE_A: PaneView = { kind: 'route', path: '/a' };
const ROUTE_B: PaneView = { kind: 'route', path: '/b' };
const ROUTE_C: PaneView = { kind: 'route', path: '/c' };
const ARTIFACT: PaneView = { kind: 'artifact', path: '/tmp/x.html' };

beforeEach(() => {
  const root = makeLeaf(ROUTE_A);
  usePaneStore.getState().hydrate({
    root,
    focusedId: root.id,
    closedHistory: [],
  });
  usePaneStore.setState({ history: {}, refreshTicks: {} });
});

function paneId(): string {
  return usePaneStore.getState().focusedId;
}

describe('pane history actions', () => {
  it('pushHistory seeds a new entry on first push', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    const h = usePaneStore.getState().history[id];
    expect(h).toEqual({ entries: [ROUTE_A], index: 0 });
  });

  it('pushHistory appends and advances the index', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().pushHistory(id, ROUTE_B);
    const h = usePaneStore.getState().history[id];
    expect(h?.entries).toEqual([ROUTE_A, ROUTE_B]);
    expect(h?.index).toBe(1);
  });

  it('pushHistory is idempotent on identical-top entries', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    const h = usePaneStore.getState().history[id];
    expect(h?.entries).toHaveLength(1);
  });

  it('historyBack walks the cursor and replaces the active view', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ROUTE_B);
    expect(usePaneStore.getState().focusedView()).toEqual(ROUTE_B);

    const back = usePaneStore.getState().historyBack(id);
    expect(back).toEqual(ROUTE_A);
    expect(usePaneStore.getState().focusedView()).toEqual(ROUTE_A);
    expect(usePaneStore.getState().history[id]?.index).toBe(0);
  });

  it('historyForward walks the cursor forward and replaces the active view', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ROUTE_B);
    usePaneStore.getState().historyBack(id);
    expect(usePaneStore.getState().focusedView()).toEqual(ROUTE_A);

    const fwd = usePaneStore.getState().historyForward(id);
    expect(fwd).toEqual(ROUTE_B);
    expect(usePaneStore.getState().focusedView()).toEqual(ROUTE_B);
  });

  it('historyBack at index 0 returns null without mutating', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    const r = usePaneStore.getState().historyBack(id);
    expect(r).toBeNull();
    expect(usePaneStore.getState().history[id]?.index).toBe(0);
  });

  it('historyForward at the newest entry returns null without mutating', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().pushHistory(id, ROUTE_B);
    const r = usePaneStore.getState().historyForward(id);
    expect(r).toBeNull();
    expect(usePaneStore.getState().history[id]?.index).toBe(1);
  });

  it('replaceActiveViewAndPushHistory truncates the forward stack', () => {
    const id = paneId();
    usePaneStore.getState().pushHistory(id, ROUTE_A);
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ROUTE_B);
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ROUTE_C);
    // Step back twice → at /a, with /b and /c ahead.
    usePaneStore.getState().historyBack(id);
    usePaneStore.getState().historyBack(id);
    expect(usePaneStore.getState().focusedView()).toEqual(ROUTE_A);

    // Replace at the back-position should drop /b and /c.
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ARTIFACT);
    const h = usePaneStore.getState().history[id];
    expect(h?.entries).toEqual([ROUTE_A, ARTIFACT]);
    expect(h?.index).toBe(1);
  });

  it('replaceActiveViewAndPushHistory preserves the active tab pinned flag', () => {
    const id = paneId();
    usePaneStore.getState().setTabPinned(id, 0, true);
    usePaneStore.getState().replaceActiveViewAndPushHistory(id, ROUTE_B);
    const view = usePaneStore.getState().focusedView();
    expect(view).toEqual({ ...ROUTE_B, pinned: true });
  });

  it('replaceActiveViewAndPushHistory is a no-op for unknown pane', () => {
    const before = usePaneStore.getState();
    usePaneStore.getState().replaceActiveViewAndPushHistory('does-not-exist', ROUTE_B);
    const after = usePaneStore.getState();
    expect(after.root).toBe(before.root);
    expect(after.history).toBe(before.history);
  });

  it('historyBack returns null for an unknown pane', () => {
    expect(usePaneStore.getState().historyBack('nope')).toBeNull();
  });

  it('historyForward returns null for an unknown pane', () => {
    expect(usePaneStore.getState().historyForward('nope')).toBeNull();
  });

  it('refreshPane increments the per-pane tick', () => {
    const id = paneId();
    const before = usePaneStore.getState().refreshTicks[id] ?? 0;
    usePaneStore.getState().refreshPane(id);
    const after = usePaneStore.getState().refreshTicks[id] ?? 0;
    expect(after).toBe(before + 1);
  });
});
