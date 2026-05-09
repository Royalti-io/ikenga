// HTML5 native drag-and-drop drop targets for tab moves.
//
// Rendered overlaid on each pane's body area while a tab drag is active
// (the dataTransfer-bearing dragstart from `pane-tab-strip` or the dock
// flips `useDragState` to true, which makes this component visible). The
// overlay reports a dragover-relative zone (4 edges or center) and either
// dispatches a `moveTab` action (pane-source) or transfers the view from
// the dock into the pane (dock-source).
//
// Edge inset is 25% of the pane's width/height. Outside that ring the
// zone is `'center'` (move-as-tab). Inside it, `'left'` / `'right'`
// split the pane horizontally (panes side-by-side); `'top'` / `'bottom'`
// split vertically. Edge zones are blocked when the tree is at the
// 6-leaf cap; center still works.

import { useState } from 'react';

import { useDragState } from '@/lib/panes/drag-state';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useDockStore } from '@/shell/dock/dock-store';
import { type PaneId } from '@/lib/panes/types';
import { cn } from '@/components/ui/utils';

const EDGE_INSET = 0.25;

type Zone = 'center' | 'top' | 'right' | 'bottom' | 'left';

function detectZone(rect: DOMRect, x: number, y: number): Zone {
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  if (relX < EDGE_INSET) return 'left';
  if (relX > 1 - EDGE_INSET) return 'right';
  if (relY < EDGE_INSET) return 'top';
  if (relY > 1 - EDGE_INSET) return 'bottom';
  return 'center';
}

export function PaneDropZones({ paneId }: { paneId: PaneId }) {
  const drag = useDragState();
  const moveTab = usePaneStore((s) => s.moveTab);
  const placeView = usePaneStore((s) => s.placeView);
  const canSplit = usePaneStore((s) => s.canSplit());
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);

  // No-op self-drag of a pane's only tab (pane-source only — dock id can
  // never collide with a pane id).
  const sameAsSrc = drag.source === 'pane' && drag.srcLeafId === paneId;

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!drag.active) return;
    // WebKit/Tauri requires preventDefault on dragenter for subsequent
    // dragover events to fire reliably on absolutely-positioned overlays.
    e.preventDefault();
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!drag.active) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const zone = detectZone(rect, e.clientX, e.clientY);
    if (zone !== 'center' && !canSplit) {
      setHoverZone(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    setHoverZone(zone);
    e.dataTransfer.dropEffect = 'move';
  }

  function onDragLeave() {
    setHoverZone(null);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!drag.active) return;
    e.preventDefault();
    if (drag.srcTabIdx == null) {
      drag.end();
      setHoverZone(null);
      return;
    }
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const zone = detectZone(rect, e.clientX, e.clientY);
    if (zone !== 'center' && !canSplit) {
      drag.end();
      setHoverZone(null);
      return;
    }

    const mode =
      zone === 'center'
        ? 'append'
        : zone === 'left'
          ? 'left'
          : zone === 'right'
            ? 'right'
            : zone === 'top'
              ? 'top'
              : 'bottom';

    if (drag.source === 'pane') {
      if (drag.srcLeafId == null) {
        drag.end();
        setHoverZone(null);
        return;
      }
      moveTab(drag.srcLeafId, drag.srcTabIdx, paneId, mode);
    } else if (drag.source === 'dock') {
      // Dock → pane: pull the view out of the dock store and place it via
      // the pane store. Only close from the dock if the placement succeeds.
      const view = useDockStore.getState().tabs[drag.srcTabIdx];
      if (!view) {
        drag.end();
        setHoverZone(null);
        return;
      }
      const ok = placeView(paneId, view, mode);
      if (ok) useDockStore.getState().closeTab(drag.srcTabIdx);
    }

    drag.end();
    setHoverZone(null);
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-20',
        // Stay mounted so WebKit registers us as a drop target before the
        // user starts dragging; only intercept events while a drag is in
        // flight.
        drag.active ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid={`drop-zone-${paneId}`}
    >
      <ZoneIndicator zone={hoverZone} dimmed={sameAsSrc && hoverZone === 'center'} />
    </div>
  );
}

interface ZoneIndicatorProps {
  zone: Zone | null;
  dimmed: boolean;
}

function ZoneIndicator({ zone, dimmed }: ZoneIndicatorProps) {
  if (!zone) return null;
  const base =
    'absolute border-2 border-primary/70 bg-primary/15 transition-opacity';
  const positional = (() => {
    switch (zone) {
      case 'center':
        return 'inset-3 rounded-md';
      case 'left':
        return 'left-0 top-0 bottom-0 w-1/4 rounded-r-md';
      case 'right':
        return 'right-0 top-0 bottom-0 w-1/4 rounded-l-md';
      case 'top':
        return 'top-0 left-0 right-0 h-1/4 rounded-b-md';
      case 'bottom':
        return 'bottom-0 left-0 right-0 h-1/4 rounded-t-md';
    }
  })();
  return <div className={cn(base, positional, dimmed && 'opacity-30')} />;
}
