// Generic per-pane navigation history hook for the URL bar.
//
// History entries are recorded as `PaneView` snapshots and live on the
// `usePaneStore` (so they survive the toolbar's render cycle but reset on
// reload — we deliberately don't persist them, matching browser semantics).
//
// `back`/`forward` swap the leaf's active tab in place via
// `replaceActiveViewAndPushHistory`'s sibling reducer; they don't modify the
// forward stack (so re-pressing back/forward walks the entries linearly).
// `push` records a forward navigation and truncates anything ahead of the
// cursor — the standard browser model.

import { useEffect, useMemo } from 'react';
import { usePaneStore } from './pane-store';
import type { PaneId, PaneView } from './types';

export interface UsePaneHistoryReturn {
  current: PaneView | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Step back one entry. Returns the resulting view (or null if no-op). */
  back: () => PaneView | null;
  /** Step forward one entry. Returns the resulting view (or null if no-op). */
  forward: () => PaneView | null;
  /** Append `view` to history and truncate any forward stack. Idempotent
   * if the top of history already matches. Does NOT change the rendered
   * leaf — callers that want both should call `replace` instead. */
  push: (view: PaneView) => void;
  /** Replace the leaf's active view AND record a history entry. The URL
   * bar uses this when the user types a new address. */
  replace: (view: PaneView) => void;
  /** Force the leaf's content to remount (refresh button). Bumps the
   * pane's `refreshTick`. */
  bumpKey: () => void;
}

/**
 * Per-pane history hook. Pass the leaf's id and the current view; the hook
 * seeds history on first use so `current` is always non-null when an active
 * view exists.
 */
export function usePaneHistory(paneId: PaneId, activeView: PaneView | null): UsePaneHistoryReturn {
  const history = usePaneStore((s) => s.history[paneId]);
  const pushHistory = usePaneStore((s) => s.pushHistory);
  const replaceActiveViewAndPushHistory = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
  const historyBack = usePaneStore((s) => s.historyBack);
  const historyForward = usePaneStore((s) => s.historyForward);
  const refreshPane = usePaneStore((s) => s.refreshPane);

  // Seed: if the pane has no history yet but does have an active view,
  // record it so back/forward can be reasoned about consistently. Also
  // record subsequent in-place changes (e.g., user clicked a sidebar link
  // that retargeted the active tab) so the URL bar reflects them.
  useEffect(() => {
    if (!activeView) return;
    pushHistory(paneId, activeView);
  }, [paneId, activeView, pushHistory]);

  return useMemo<UsePaneHistoryReturn>(() => {
    const current = history ? (history.entries[history.index] ?? activeView) : activeView;
    const canGoBack = !!history && history.index > 0;
    const canGoForward = !!history && history.index < history.entries.length - 1;
    return {
      current,
      canGoBack,
      canGoForward,
      back: () => historyBack(paneId),
      forward: () => historyForward(paneId),
      push: (view) => pushHistory(paneId, view),
      replace: (view) => replaceActiveViewAndPushHistory(paneId, view),
      bumpKey: () => refreshPane(paneId),
    };
  }, [
    history,
    activeView,
    paneId,
    historyBack,
    historyForward,
    pushHistory,
    replaceActiveViewAndPushHistory,
    refreshPane,
  ]);
}
