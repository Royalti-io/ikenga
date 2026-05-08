import { useEffect } from 'react';
import {
  LayoutGrid,
  Inbox,
  Send,
  Clapperboard,
  Bot,
  Folder,
  SquareTerminal,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useShellStore, type ActivityMode, type CoreMode } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useIkengaStore, type IkengaWorkspace } from '@/lib/ikenga/theme-store';
import { MINI_APPS } from './mini-apps-config';
import { cn } from '@/components/ui/utils';

interface CoreItem {
  mode: CoreMode;
  label: string;
  Icon: LucideIcon;
  shortcut: string;
}

// Ikenga locks 7 first-class workspaces in this order (design/system §1).
const CORE_TOP: CoreItem[] = [
  { mode: 'app',      label: 'App',      Icon: LayoutGrid,     shortcut: '⌘1' },
  { mode: 'mail',     label: 'Mail',     Icon: Inbox,          shortcut: '⌘2' },
  { mode: 'outbox',   label: 'Outbox',   Icon: Send,           shortcut: '⌘3' },
  { mode: 'studio',   label: 'Studio',   Icon: Clapperboard,   shortcut: '⌘4' },
  { mode: 'agents',   label: 'Agents',   Icon: Bot,            shortcut: '⌘5' },
  { mode: 'files',    label: 'Files',    Icon: Folder,         shortcut: '⌘6' },
  { mode: 'sessions', label: 'Sessions', Icon: SquareTerminal, shortcut: '⌘7' },
];

const CORE_BOTTOM: CoreItem[] = [
  { mode: 'settings', label: 'Settings', Icon: Settings, shortcut: '⌘,' },
];

const SHORTCUT_MAP: Record<string, ActivityMode> = {
  '1': 'app',
  '2': 'mail',
  '3': 'outbox',
  '4': 'studio',
  '5': 'agents',
  '6': 'files',
  '7': 'sessions',
  ',': 'settings',
};

// Mini-apps that don't have their own workspace tint roll up to 'studio'.
function modeToWorkspace(mode: ActivityMode): IkengaWorkspace {
  switch (mode) {
    case 'app':
    case 'mail':
    case 'outbox':
    case 'studio':
    case 'agents':
    case 'files':
    case 'sessions':
    case 'settings':
      return mode;
    default:
      return 'studio';
  }
}

export function ActivityBar() {
  const activeMode = useShellStore((s) => s.activeMode);
  const setActiveMode = useShellStore((s) => s.setActiveMode);
  const setWorkspace = useIkengaStore((s) => s.setWorkspace);

  // Mirror activeMode → ikenga.workspace so the data-workspace attribute on
  // <html> drives all the workspace-tint variables.
  useEffect(() => {
    setWorkspace(modeToWorkspace(activeMode));
  }, [activeMode, setWorkspace]);

  // Settings is a real route, not a sidebar mode. Clicking the rail icon (or
  // hitting ⌘,) needs to: flip activeMode (for workspace tint) AND open
  // /settings in the focused pane.
  //
  // We drive the pane store directly rather than going through
  // `useNavigate()` (workspace router). The workspace router de-duplicates
  // navigations — if the URL already matches `/settings/appearance` (e.g.
  // because Direction B in router-pane-sync left it there before the user
  // switched the focused tab to a non-route view), `navigate()` is a no-op
  // and the focused pane never gets the action. Calling navigateFocused
  // directly is unconditional; Direction B then syncs URL afterward.
  //
  // We pass the canonical landing path `/settings/appearance` (matching the
  // /settings → /settings/appearance redirect) so dedup hits an already-open
  // settings tab rather than creating a duplicate.
  const SETTINGS_LANDING = '/settings/appearance';

  function handleSelectMode(mode: ActivityMode) {
    setActiveMode(mode);
    if (mode === 'settings') {
      usePaneStore.getState().navigateFocused(SETTINGS_LANDING);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      const next = SHORTCUT_MAP[e.key];
      if (!next) return;
      e.preventDefault();
      setActiveMode(next);
      if (next === 'settings') {
        usePaneStore.getState().navigateFocused(SETTINGS_LANDING);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveMode]);

  return (
    <nav
      aria-label="Activity bar"
      className="flex h-full w-14 shrink-0 flex-col items-center border-r border-border-soft py-3"
      style={{ background: 'var(--bg-base)' }}
    >
      {CORE_TOP.map((item) => (
        <RailButton
          key={item.mode}
          mode={item.mode}
          label={item.label}
          Icon={item.Icon}
          shortcut={item.shortcut}
          isActive={activeMode === item.mode}
          onSelect={handleSelectMode}
        />
      ))}

      {MINI_APPS.length > 0 && (
        <div
          aria-hidden="true"
          className="my-2 h-px w-7 shrink-0"
          style={{ background: 'var(--border-soft)' }}
        />
      )}

      {MINI_APPS.map((app) => (
        <RailButton
          key={app.id}
          mode={app.id}
          label={app.name}
          Icon={app.Icon}
          shortcut={app.phaseTag}
          isActive={activeMode === app.id}
          onSelect={handleSelectMode}
        />
      ))}

      <div className="mt-auto" />

      {CORE_BOTTOM.map((item) => (
        <RailButton
          key={item.mode}
          mode={item.mode}
          label={item.label}
          Icon={item.Icon}
          shortcut={item.shortcut}
          isActive={activeMode === item.mode}
          onSelect={handleSelectMode}
        />
      ))}
    </nav>
  );
}

interface RailButtonProps {
  mode: ActivityMode;
  label: string;
  Icon: LucideIcon;
  shortcut: string;
  isActive: boolean;
  onSelect: (m: ActivityMode) => void;
}

// Mirrors `.rail-icon` from design/concepts/_shared/components.css.
function RailButton({ mode, label, Icon, shortcut, isActive, onSelect }: RailButtonProps) {
  // Resolve this rail icon's workspace tint at render time. For the active
  // item, we want the workspace's own tint; for inactive items the cascaded
  // --tint-fg-active belongs to a *different* workspace, so we look up by
  // role per-button instead.
  const ws = modeToWorkspace(mode);
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      title={`${label} (${shortcut})`}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      data-ws={ws}
      className={cn(
        'relative my-0.5 grid h-9 w-9 place-items-center rounded-md transition-colors',
        'hover:bg-card',
      )}
      style={{
        color: isActive ? `var(--tint-${ws}-fg)` : 'var(--fg-faint)',
        background: isActive ? 'var(--bg-raised)' : undefined,
      }}
    >
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute -left-0.5 top-2 bottom-2 w-0.5 rounded-r"
          style={{ background: `var(--tint-${ws}-fg)` }}
        />
      )}
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}
