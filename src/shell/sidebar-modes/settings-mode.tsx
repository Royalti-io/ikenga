import { useState } from 'react';
import { Sun, Moon, Plus, Trash2, RotateCcw, ExternalLink, Package } from 'lucide-react';
import { useIkengaStore, type IkengaMode } from '@/lib/ikenga/theme-store';
import { useShellStore, DEFAULT_FILE_ROOTS } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { cn } from '@/components/ui/utils';

const SHORTCUTS: Array<{ key: string; action: string }> = [
  { key: '⌘1', action: 'App' },
  { key: '⌘2', action: 'Mail' },
  { key: '⌘3', action: 'Outbox' },
  { key: '⌘4', action: 'Studio' },
  { key: '⌘5', action: 'Agents' },
  { key: '⌘6', action: 'Files' },
  { key: '⌘7', action: 'Sessions' },
  { key: '⌘,', action: 'Settings' },
  { key: '⌘B', action: 'Toggle sidebar' },
  { key: '⌘J', action: 'Cycle dock state' },
  { key: '⌘\\', action: 'Split focused pane right' },
  { key: '⌘⇧\\', action: 'Split focused pane down' },
  { key: '⌘W', action: 'Close focused tab / pane' },
  { key: '⌘T', action: 'New terminal in focused pane' },
  { key: '⌘⇧T', action: 'New Claude terminal in focused pane' },
  { key: '⌃1–⌃6', action: 'Focus pane N' },
  { key: '⌘K', action: 'Command palette' },
];

export function SettingsMode() {
  return (
    <div className="h-full overflow-y-auto">
      <ThemeSection />
      <PackagesSection />
      <FileRootsSection />
      <KeybindingsSection />
      <FullSettingsLink />
    </div>
  );
}

function PackagesSection() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  return (
    <Section title="Packages">
      <button
        type="button"
        onClick={() => navigateFocused('/install')}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <Package className="h-3.5 w-3.5" />
          Install a package
        </span>
        <ExternalLink className="h-3 w-3 opacity-60" />
      </button>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Sidecars · cron · MCP · iyke routes · skills · settings — added through a Claude
        conversation, registered atomically by the kernel.
      </p>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function ThemeSection() {
  const mode = useIkengaStore((s) => s.mode);
  const setMode = useIkengaStore((s) => s.setMode);
  const options: Array<{ value: IkengaMode; label: string; Icon: typeof Sun }> = [
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'light', label: 'Light', Icon: Sun },
  ];

  return (
    <Section title="Mode">
      <div className="grid grid-cols-2 gap-1">
        {options.map(({ value, label, Icon }) => {
          const isActive = mode === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs transition-colors',
                isActive
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Theme + density + workspace tint live on the full settings page.
      </p>
    </Section>
  );
}

function FileRootsSection() {
  const fileRoots = useShellStore((s) => s.fileRoots);
  const addFileRoot = useShellStore((s) => s.addFileRoot);
  const removeFileRoot = useShellStore((s) => s.removeFileRoot);
  const resetFileRoots = useShellStore((s) => s.resetFileRoots);
  const [draft, setDraft] = useState('');

  const isDirty =
    fileRoots.length !== DEFAULT_FILE_ROOTS.length ||
    fileRoots.some((r, i) => r !== DEFAULT_FILE_ROOTS[i]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    addFileRoot(draft);
    setDraft('');
  }

  return (
    <Section title="File roots">
      <ul className="flex flex-col gap-1">
        {fileRoots.map((root) => (
          <li
            key={root}
            className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <code className="flex-1 truncate font-mono text-foreground" title={root}>
              {root}
            </code>
            <button
              type="button"
              onClick={() => removeFileRoot(root)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
              aria-label={`Remove ${root}`}
              title="Remove"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-2 flex gap-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="~/path/to/dir"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs',
            'hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          aria-label="Add root"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </form>
      {isDirty && (
        <button
          type="button"
          onClick={resetFileRoots}
          className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          Reset to defaults
        </button>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground italic">
        Reads outside the Tauri allowlist (
        <code className="font-mono">src-tauri/capabilities/default.json</code>) will
        fail. Update that file before adding new roots.
      </div>
    </Section>
  );
}

function KeybindingsSection() {
  return (
    <Section title="Keybindings">
      <ul className="flex flex-col gap-0.5">
        {SHORTCUTS.map(({ key, action }) => (
          <li
            key={key}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="text-muted-foreground">{action}</span>
            <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              {key}
            </kbd>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function FullSettingsLink() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => navigateFocused('/settings')}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span>Open full settings page</span>
        <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}
