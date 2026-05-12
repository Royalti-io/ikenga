import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import {
  Plus,
  Terminal as TerminalIcon,
  MessageSquare,
  Hash,
} from 'lucide-react';
import type { LeafNode, PaneView } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { mintThreadId } from '@/chat';
import { defaultCwd } from '@/lib/shell/default-cwd';
import { sessionEnsure } from '@/lib/tauri-cmd';
import { NAV_GROUPS } from '@/shell/nav-config';

interface NewTabMenuProps {
  leaf: LeafNode;
  open: boolean;
  onClose: () => void;
  anchor: { top: number; left: number } | null;
}

export function NewTabMenu({ leaf, open, onClose, anchor }: NewTabMenuProps) {
  const addTab = usePaneStore((s) => s.addTab);
  const focusPane = usePaneStore((s) => s.focusPane);

  // Click outside to close. Defer one tick so the click that opened the
  // menu isn't itself caught here.
  useEffect(() => {
    if (!open) return;
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const [search, setSearch] = useState('');

  if (!open || !anchor) return null;

  function commit(view: PaneView) {
    focusPane(leaf.id);
    addTab(leaf.id, view);
    onClose();
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-80 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <Command label="New tab" className="flex flex-col">
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Open…"
          className="w-full border-b border-border bg-transparent px-3 py-2 text-xs outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-72 overflow-y-auto p-1">
          <Command.Empty className="py-4 text-center text-xs text-muted-foreground">
            No matches.
          </Command.Empty>

          <Command.Group heading="Pane type" className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <MenuItem
              onSelect={() =>
                commit({ kind: 'terminal', sessionId: createTerminalSession() })
              }
              Icon={TerminalIcon}
              label="Terminal (bash)"
              shortcut="⌘T"
            />
            <MenuItem
              onSelect={() =>
                commit({
                  kind: 'terminal',
                  sessionId: createTerminalSession({ cmd: ['claude'], title: 'claude' }),
                })
              }
              Icon={TerminalIcon}
              label="Claude terminal"
              shortcut="⌘⇧T"
            />
            <MenuItem
              onSelect={() => {
                const threadId = mintThreadId();
                void sessionEnsure(threadId, defaultCwd(), {}).catch((e) =>
                  console.warn('sessionEnsure (new-tab):', e),
                );
                commit({ kind: 'chat', sessionId: threadId });
              }}
              Icon={MessageSquare}
              label="New Chat"
              detail="streaming Claude"
            />
          </Command.Group>

          <Command.Group heading="Routes" className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {NAV_GROUPS.flatMap((g) => g.items).map(({ to, label, Icon }) => (
              <MenuItem
                key={to}
                onSelect={() => commit({ kind: 'route', path: to })}
                Icon={Icon}
                label={label}
                detail={to}
              />
            ))}
          </Command.Group>

          <Command.Group heading="Files" className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <Command.Item
              onSelect={() => onClose()}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground"
            >
              <Hash className="h-3.5 w-3.5" />
              <span>Open via Files mode in the sidebar</span>
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

interface MenuItemProps {
  onSelect: () => void;
  Icon: typeof Plus;
  label: string;
  shortcut?: string;
  detail?: string;
}

function MenuItem({ onSelect, Icon, label, shortcut, detail }: MenuItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {detail && (
        <span className="ml-2 truncate text-[10px] text-muted-foreground">
          {detail}
        </span>
      )}
      {shortcut && (
        <kbd className="ml-2 shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

export function useAnchorRect(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setRect({ top: r.bottom + 2, left: Math.max(r.left - 240, 8) });
  }, [open, ref]);
  return rect;
}
