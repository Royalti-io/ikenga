import { useEffect } from 'react';
import {
  LayoutGrid,
  Folder,
  SquareTerminal,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useShellStore, type ActivityMode, type CoreMode } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useIkengaStore, type IkengaWorkspace } from '@/lib/ikenga/theme-store';
import { cn } from '@/components/ui/utils';

interface CoreItem {
  mode: CoreMode;
  label: string;
  Icon: LucideIcon;
  shortcut: string;
}

// Post-strip: 3 top + Settings. App pkgs no longer claim rail icons.
const CORE_TOP: CoreItem[] = [
  { mode: 'app',      label: 'App',      Icon: LayoutGrid,     shortcut: '⌘1' },
  { mode: 'files',    label: 'Files',    Icon: Folder,         shortcut: '⌘2' },
  { mode: 'sessions', label: 'Sessions', Icon: SquareTerminal, shortcut: '⌘3' },
];

const CORE_BOTTOM: CoreItem[] = [
  { mode: 'settings', label: 'Settings', Icon: Settings, shortcut: '⌘,' },
];

const SHORTCUT_MAP: Record<string, ActivityMode> = {
  '1': 'app',
  '2': 'files',
  '3': 'sessions',
  ',': 'settings',
};

// Workspace tint mirrors core mode 1:1 post-strip; no mini-app rollup.
function modeToWorkspace(mode: ActivityMode): IkengaWorkspace {
  return mode;
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

function RailButton({ mode, label, Icon, shortcut, isActive, onSelect }: RailButtonProps) {
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
