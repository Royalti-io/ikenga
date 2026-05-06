import { useEffect, useMemo, useRef, useState } from 'react';
import { Pin, PinOff, Plus, X } from 'lucide-react';
import { type LeafNode } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useDragState } from '@/lib/panes/drag-state';
import { viewLabel, viewSubtitle } from './pane-views';
import { viewWorkspace } from './tab-workspace';
import { NewTabMenu, useAnchorRect } from './new-tab-menu';
import { cn } from '@/components/ui/utils';

interface PaneTabStripProps {
  leaf: LeafNode;
  isFocused: boolean;
}

export function PaneTabStrip({ leaf, isFocused }: PaneTabStripProps) {
  const switchTab = usePaneStore((s) => s.switchTab);
  const closeTab = usePaneStore((s) => s.closeTab);
  const focusPane = usePaneStore((s) => s.focusPane);
  const toggleTabPinned = usePaneStore((s) => s.toggleTabPinned);
  const reorderTab = usePaneStore((s) => s.reorderTab);

  const [menuOpen, setMenuOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const anchor = useAnchorRect(menuOpen, addBtnRef);

  // Drop indicator for in-strip reorder: { idx, side }. `side='before'`
  // means the drop will insert *before* tab idx; `'after'` means after.
  const [dropAt, setDropAt] = useState<{ idx: number; side: 'before' | 'after' } | null>(null);

  // Scroll the active tab into view whenever the active index changes
  // (covers dedup-switch, programmatic switches, and reorder).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = activeTabRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [leaf.activeTabIdx, leaf.tabs.length]);

  // Per design/concepts/_shared/shell.css §"Workspace tint on tabs":
  // single-workspace strips suppress inactive hairlines (the pane focus
  // accent already announces the workspace). Mixed strips opt in to the
  // tabstrip-ws-mixed treatment so inactive tabs each show their own
  // workspace's hairline at low alpha.
  const isMixedWorkspace = useMemo(() => {
    if (leaf.tabs.length < 2) return false;
    const ws = leaf.tabs.map(viewWorkspace);
    return ws.some((w) => w !== ws[0]);
  }, [leaf.tabs]);

  function handleAddClick() {
    focusPane(leaf.id);
    setMenuOpen((v) => !v);
  }

  return (
    <div
      data-tabstrip-mixed={isMixedWorkspace ? 'true' : 'false'}
      className={cn(
        'ikenga-tab-strip flex h-8 shrink-0 items-stretch border-b border-border bg-card',
        isFocused ? 'opacity-100' : 'opacity-80',
      )}
    >
      <div
        ref={scrollerRef}
        className="flex flex-1 items-stretch overflow-x-auto [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {leaf.tabs.map((tab, idx) => {
          const isActive = idx === leaf.activeTabIdx;
          const isPinned = Boolean(tab.pinned);
          const ws = viewWorkspace(tab);
          return (
            <button
              type="button"
              key={`${idx}-${tab.kind}`}
              ref={isActive ? activeTabRef : undefined}
              data-ws={ws}
              data-active={isActive ? 'true' : 'false'}
              draggable={!isPinned}
              onDragStart={(e) => {
                if (isPinned) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.effectAllowed = 'move';
                // Some browsers require dataTransfer to have data set or
                // they cancel the drag. The actual payload lives in
                // useDragState — this is just a non-empty marker.
                e.dataTransfer.setData('application/x-pane-tab', `${leaf.id}:${idx}`);
                useDragState.getState().startPane(leaf.id, idx);
              }}
              onDragEnd={() => {
                useDragState.getState().end();
                setDropAt(null);
              }}
              onDragOver={(e) => {
                const drag = useDragState.getState();
                if (drag.source !== 'pane' || drag.srcLeafId !== leaf.id) return;
                if (drag.srcTabIdx === idx) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                setDropAt((prev) =>
                  prev && prev.idx === idx && prev.side === side ? prev : { idx, side },
                );
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the button entirely, not when entering a child.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDropAt((prev) => (prev?.idx === idx ? null : prev));
              }}
              onDrop={(e) => {
                const drag = useDragState.getState();
                if (drag.source !== 'pane' || drag.srcLeafId !== leaf.id) return;
                if (drag.srcTabIdx === null || drag.srcTabIdx === idx) {
                  setDropAt(null);
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                const from = drag.srcTabIdx;
                // Compute destination index in the *current* tabs array.
                let to = side === 'before' ? idx : idx + 1;
                if (from < to) to -= 1;
                reorderTab(leaf.id, from, to);
                setDropAt(null);
                drag.end();
              }}
              onClick={() => {
                focusPane(leaf.id);
                switchTab(leaf.id, idx);
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && !isPinned) {
                  e.preventDefault();
                  closeTab(leaf.id, idx);
                }
              }}
              className={cn(
                'group relative flex shrink-0 items-center gap-2 border-r border-border text-xs transition-colors',
                isPinned
                  ? 'min-w-[32px] max-w-[140px] px-2'
                  : 'min-w-[120px] max-w-[180px] px-3',
                isActive
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                dropAt?.idx === idx && dropAt.side === 'before'
                  ? 'before:absolute before:left-0 before:top-0 before:h-full before:w-0.5 before:bg-primary'
                  : null,
                dropAt?.idx === idx && dropAt.side === 'after'
                  ? 'after:absolute after:right-0 after:top-0 after:h-full after:w-0.5 after:bg-primary'
                  : null,
              )}
              title={`${viewLabel(tab)}${isPinned ? ' (pinned)' : ''}\n${viewSubtitle(tab)}`}
            >
              {isPinned && (
                <Pin className="h-3 w-3 shrink-0 -rotate-45 text-foreground/70" />
              )}
              <span className="truncate capitalize">{viewLabel(tab)}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={isPinned ? 'Unpin tab' : 'Pin tab'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleTabPinned(leaf.id, idx);
                }}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded',
                  'opacity-0 group-hover:opacity-100 hover:bg-muted',
                  isActive && 'opacity-60',
                )}
              >
                {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              </span>
              {!isPinned && (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(leaf.id, idx);
                  }}
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded',
                    'opacity-0 group-hover:opacity-100 hover:bg-muted',
                    isActive && 'opacity-60',
                  )}
                >
                  <X className="h-3 w-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        ref={addBtnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleAddClick();
        }}
        title="New tab in pane"
        aria-label="New tab"
        aria-expanded={menuOpen}
        className="flex h-full w-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <NewTabMenu
        leaf={leaf}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={anchor}
      />
    </div>
  );
}
