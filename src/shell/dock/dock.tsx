import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Pin, MessageSquare, Terminal as TerminalIcon } from 'lucide-react';
import { type PaneView } from '@/lib/panes/types';
import { useDockStore, type DockState } from './dock-store';
import { useDragState } from '@/lib/panes/drag-state';
import { usePaneStore } from '@/lib/panes/pane-store';
import { PaneBody, viewLabel } from '@/shell/panes/pane-views';
import { viewWorkspace } from '@/shell/panes/tab-workspace';
import { createTerminalSession } from '@/terminal/single-terminal';
import { cn } from '@/components/ui/utils';

const STATE_WIDTHS: Record<DockState, string> = {
  hidden: '0px',
  collapsed: '36px',
  expanded: '380px',
  wide: '480px',
};

export function Dock() {
  const dockState = useDockStore((s) => s.state);
  const tabs = useDockStore((s) => s.tabs);
  const activeIdx = useDockStore((s) => s.activeIdx);
  const setState = useDockStore((s) => s.setState);
  const switchTab = useDockStore((s) => s.switchTab);
  const closeTab = useDockStore((s) => s.closeTab);
  const togglePinned = useDockStore((s) => s.togglePinned);
  const addTab = useDockStore((s) => s.addTab);
  const appendView = useDockStore((s) => s.appendView);

  const drag = useDragState();
  const [dropHover, setDropHover] = useState(false);

  if (dockState === 'hidden') return null;

  const width = STATE_WIDTHS[dockState];

  // Pane → dock: detach the source tab and append it as a dock tab. We use
  // moveTab to a sentinel pane id won't work, so instead we read the source
  // view directly off the pane store and explicitly closeTab there. Dock →
  // dock drops are no-ops for now (in-dock reordering is out of scope).
  function handleExternalDrop() {
    setDropHover(false);
    if (
      !drag.active ||
      drag.source !== 'pane' ||
      drag.srcLeafId == null ||
      drag.srcTabIdx == null
    ) {
      drag.end();
      return;
    }
    const paneStore = usePaneStore.getState();
    const root = paneStore.root;
    const srcLeaf = findLeafShallow(root, drag.srcLeafId);
    if (!srcLeaf) {
      drag.end();
      return;
    }
    const view = srcLeaf.tabs[drag.srcTabIdx];
    if (!view) {
      drag.end();
      return;
    }
    // Append into dock first, then close from source pane.
    appendView(view);
    paneStore.closeTab(drag.srcLeafId, drag.srcTabIdx);
    drag.end();
  }

  if (dockState === 'collapsed') {
    return (
      <aside
        aria-label="Dock"
        className="flex h-full flex-col border-l py-3"
        style={{
          width,
          background: 'var(--bg-base)',
          borderColor: 'var(--border-soft)',
        }}
        onDragOver={(e) => {
          if (drag.active) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={handleExternalDrop}
      >
        <div className="flex flex-col items-center gap-1 px-1">
          {tabs.map((tab, idx) => {
            const ws = viewWorkspace(tab);
            const isActive = idx === activeIdx;
            const isPinned = Boolean(tab.pinned);
            return (
              <button
                key={`${idx}-${tab.kind}`}
                type="button"
                draggable={!isPinned}
                onDragStart={(e) => {
                  if (isPinned) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('application/x-dock-tab', `${idx}`);
                  useDragState.getState().startDock(idx);
                }}
                onDragEnd={() => useDragState.getState().end()}
                onClick={() => {
                  switchTab(idx);
                  setState('expanded');
                }}
                title={viewLabel(tab)}
                aria-label={viewLabel(tab)}
                className={cn(
                  'relative grid h-7 w-7 place-items-center rounded-sm transition-colors',
                  'hover:bg-card',
                )}
                style={{
                  color: isActive ? `var(--tint-${ws}-fg)` : 'var(--fg-faint)',
                }}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-l"
                    style={{ background: `var(--tint-${ws}-fg)` }}
                  />
                )}
                <DockTabIcon view={tab} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setState('expanded')}
            title="Expand dock"
            aria-label="Expand dock"
            className="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-card"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>
    );
  }

  // expanded | wide
  const activeTab = tabs[activeIdx];
  return (
    <aside
      aria-label="Dock"
      className="flex h-full flex-col border-l"
      style={{
        width,
        background: 'var(--bg-base)',
        borderColor: 'var(--border-soft)',
      }}
    >
      <div
        className="flex shrink-0 items-stretch border-b"
        style={{
          height: 'var(--tab-h)',
          borderColor: 'var(--border-soft)',
          background: 'var(--bg-sunken)',
        }}
        onDragOver={(e) => {
          if (drag.active) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropHover(true);
          }
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={handleExternalDrop}
      >
        <div
          className={cn(
            'ikenga-tab-strip flex flex-1 items-stretch gap-1 overflow-x-auto px-2',
            dropHover && 'bg-primary/10',
          )}
          data-tabstrip-mixed={tabs.length > 1 ? 'true' : 'false'}
        >
          {tabs.map((tab, idx) => {
            const ws = viewWorkspace(tab);
            const isActive = idx === activeIdx;
            const isPinned = Boolean(tab.pinned);
            return (
              <button
                key={`${idx}-${tab.kind}`}
                type="button"
                draggable={!isPinned}
                onDragStart={(e) => {
                  if (isPinned) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('application/x-dock-tab', `${idx}`);
                  useDragState.getState().startDock(idx);
                }}
                onDragEnd={() => useDragState.getState().end()}
                data-ws={ws}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => switchTab(idx)}
                onAuxClick={(e) => {
                  if (e.button === 1 && !isPinned) {
                    e.preventDefault();
                    closeTab(idx);
                  }
                }}
                className={cn(
                  'group relative flex shrink-0 items-center gap-2 px-3 text-xs',
                  'transition-colors',
                )}
                style={{
                  color: isActive ? 'var(--fg)' : 'var(--fg-faint)',
                  background: isActive ? 'var(--bg-base)' : 'transparent',
                }}
                title={viewLabel(tab)}
              >
                <DockTabIcon view={tab} />
                <span className="truncate capitalize">{viewLabel(tab)}</span>
                {isPinned && <Pin className="h-2.5 w-2.5 -rotate-45" />}
                {!isPinned && (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="Close dock tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(idx);
                    }}
                    className="grid h-3.5 w-3.5 place-items-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-card"
                    onAuxClick={(e) => {
                      e.stopPropagation();
                      togglePinned(idx);
                    }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l px-1" style={{ borderColor: 'var(--border-soft)' }}>
          <DockAddButton onAdd={addTab} />
          <button
            type="button"
            onClick={() => setState(dockState === 'expanded' ? 'wide' : 'expanded')}
            title={dockState === 'expanded' ? 'Widen dock' : 'Narrow dock'}
            aria-label="Toggle dock width"
            className="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-card"
          >
            {dockState === 'expanded' ? (
              <ChevronLeft className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setState('collapsed')}
            title="Collapse dock"
            aria-label="Collapse dock"
            className="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-card"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--bg-base)' }}>
        {activeTab ? (
          <PaneBody paneId="__dock__" view={activeTab} />
        ) : (
          <DockEmpty
            onSeed={() => {
              const sessionId = createTerminalSession({
                cmd: ['claude'],
                title: 'claude',
              });
              appendView({ kind: 'chat', sessionId });
            }}
          />
        )}
      </div>
    </aside>
  );
}

function DockTabIcon({ view }: { view: PaneView }) {
  switch (view.kind) {
    case 'chat':
      return <MessageSquare className="h-3.5 w-3.5" />;
    case 'terminal':
      return <TerminalIcon className="h-3.5 w-3.5" />;
    default:
      return <span className="h-3.5 w-3.5" aria-hidden="true" />;
  }
}

function DockAddButton({ onAdd }: { onAdd: (view: PaneView) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        const sessionId = createTerminalSession({ cmd: ['claude'], title: 'claude' });
        onAdd({ kind: 'chat', sessionId });
      }}
      title="New chat tab"
      aria-label="New chat tab"
      className="grid h-6 w-6 place-items-center rounded-sm text-muted-foreground hover:bg-card"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

function DockEmpty({ onSeed }: { onSeed: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
      <p>The dock is empty.</p>
      <p className="text-xs">
        Drag tabs in from any pane, or
        <br />
        seed a chat session.
      </p>
      <button
        type="button"
        onClick={onSeed}
        className="rounded border px-3 py-1 text-xs hover:bg-card"
        style={{ borderColor: 'var(--border)' }}
      >
        New chat
      </button>
    </div>
  );
}

// Light helper — same shape as pane-reducer's findLeaf, kept inline so the
// dock doesn't import internal pane-store machinery directly.
function findLeafShallow(node: import('@/lib/panes/types').PaneNode, id: string): import('@/lib/panes/types').LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeafShallow(child, id);
    if (found) return found;
  }
  return null;
}
