// Legacy settings sections, quarantined here for PR2 to consume.
// Lifted verbatim (with import path adjustments) from the pre-redesign
// `src/routes/settings/index.tsx`. Not rendered anywhere in PR1.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
import Database from '@tauri-apps/plugin-sql';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/components/ui/utils';
import {
  useDeleteSecret,
  useImportDotenv,
  useSetSecret,
  vaultKeysQueryOptions,
  vaultStatusQueryOptions,
} from '@/lib/queries/secrets';
import {
  DEFAULT_CLAUDE_PROJECT_ROOTS,
  DEFAULT_FILE_ROOTS,
  useShellStore,
} from '@/lib/shell/shell-store';
import {
  fsList,
  type ScreenshotConfig as ScreenshotCfg,
  screenshotGetConfig,
  screenshotSetDir,
  secretsGet,
} from '@/lib/tauri-cmd';

// Persistence keys this UI knows how to clear. Kept in one place so adding a
// new persisted store means adding it here too — the "Clear local data"
// button is otherwise a footgun.
export const KNOWN_LOCALSTORAGE_KEYS = [
  'shell-store',
  'ikenga-dock',
  'ikenga-shell',
  'entity-store',
  'terminal.tabs',
  '__boot_timings__',
];
export const LAYOUT_LS_PREFIX = '__lstate__:';
export const REVEAL_TIMEOUT_MS = 30_000;

// ─── Editable path row ───────────────────────────────────────────────────────
//
// Replaces the read-only span in path lists (file roots, claude project
// roots) with an `<input>` that commits on blur or Enter. Validation is
// best-effort (fsList(path) succeeds for valid + allowlisted directories);
// invalid paths get an aria-invalid border and the user can re-edit. We do
// NOT validate per-keystroke — that would hammer the fs commands while the
// user is mid-edit.

interface EditablePathRowProps {
  value: string;
  onCommit: (next: string) => void;
  onRemove: () => void;
  removeLabel: string;
  isDefault?: boolean;
}

function EditablePathRow({
  value,
  onCommit,
  onRemove,
  removeLabel,
  isDefault,
}: EditablePathRowProps) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);

  // Resync if the underlying value changes from outside (e.g. reset to
  // defaults) and we're not actively focused — leave focused edits alone.
  useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setDraft(value);
      setInvalid(false);
      return;
    }
    // fsList probes the directory via the same allowlist the rest of the
    // shell uses. If it throws, the path is missing OR outside the
    // allowlist — either way, not safe to commit silently.
    try {
      await fsList(trimmed);
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(trimmed);
  }

  return (
    <li className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Clear the invalid state as soon as the user resumes typing —
            // gives them visual feedback that the field is "live" again.
            if (invalid) setInvalid(false);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(value);
              setInvalid(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-invalid={invalid || undefined}
          className={cn(
            'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-xs text-foreground outline-none',
            'hover:border-border focus:border-ring focus:bg-background',
            invalid && 'border-destructive bg-destructive/5 focus:border-destructive'
          )}
          spellCheck={false}
        />
        {isDefault && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
            default
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="h-7 px-2 text-muted-foreground hover:text-red-700"
        aria-label={removeLabel}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

// ─── File roots ──────────────────────────────────────────────────────────────

export function FileRootsSectionBody() {
  const fileRoots = useShellStore((s) => s.fileRoots);
  const addFileRoot = useShellStore((s) => s.addFileRoot);
  const removeFileRoot = useShellStore((s) => s.removeFileRoot);
  const updateFileRoot = useShellStore((s) => s.updateFileRoot);
  const resetFileRoots = useShellStore((s) => s.resetFileRoots);

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string') addFileRoot(picked);
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Directories the file browser and editor are allowed to open. Changes take effect
        immediately — the Rust resolver reads from the same list. Click any path to edit it;
        press <kbd>Enter</kbd> to commit, <kbd>Esc</kbd> to revert.
      </p>
      <ul className="space-y-1 rounded-md border border-border bg-background">
        {fileRoots.map((root) => {
          const isDefault = (DEFAULT_FILE_ROOTS as readonly string[]).includes(root);
          return (
            <EditablePathRow
              key={root}
              value={root}
              onCommit={(next) => updateFileRoot(root, next)}
              onRemove={() => removeFileRoot(root)}
              removeLabel={`Remove ${root}`}
              isDefault={isDefault}
            />
          );
        })}
        {fileRoots.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted-foreground">No file roots configured.</li>
        )}
      </ul>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleAdd}>
          <FolderPlus className="mr-1 h-3.5 w-3.5" />
          Add directory
        </Button>
        <Button variant="ghost" size="sm" onClick={resetFileRoots}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

// ─── Claude Code config browser sources ─────────────────────────────────────

export function ClaudeConfigSectionBody() {
  const claudeProjectRoots = useShellStore((s) => s.claudeProjectRoots);
  const addClaudeProjectRoot = useShellStore((s) => s.addClaudeProjectRoot);
  const removeClaudeProjectRoot = useShellStore((s) => s.removeClaudeProjectRoot);
  const updateClaudeProjectRoot = useShellStore((s) => s.updateClaudeProjectRoot);
  const resetClaudeProjectRoots = useShellStore((s) => s.resetClaudeProjectRoots);
  const claudeWatchEnabled = useShellStore((s) => s.claudeWatchEnabled);
  const setClaudeWatchEnabled = useShellStore((s) => s.setClaudeWatchEnabled);

  async function handleAdd() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string') addClaudeProjectRoot(picked);
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Project roots scanned by the <code>/claude</code> config browser. Each root should contain a{' '}
        <code>.claude/</code> dir with agents/skills/commands. Personal <code>~/.claude/</code> is
        always scanned in addition to these — no need to add it.
      </p>
      <ul className="space-y-1 rounded-md border border-border bg-background">
        {claudeProjectRoots.map((root) => {
          const isDefault = (DEFAULT_CLAUDE_PROJECT_ROOTS as readonly string[]).includes(root);
          return (
            <EditablePathRow
              key={root}
              value={root}
              onCommit={(next) => updateClaudeProjectRoot(root, next)}
              onRemove={() => removeClaudeProjectRoot(root)}
              removeLabel={`Remove ${root}`}
              isDefault={isDefault}
            />
          );
        })}
        {claudeProjectRoots.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted-foreground">
            No project roots configured — only personal <code>~/.claude/</code> will be shown.
          </li>
        )}
      </ul>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleAdd}>
          <FolderPlus className="mr-1 h-3.5 w-3.5" />
          Add project root
        </Button>
        <Button variant="ghost" size="sm" onClick={resetClaudeProjectRoots}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reset to defaults
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={claudeWatchEnabled}
          onChange={(e) => setClaudeWatchEnabled(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Live-reload on file changes (uses fs watcher)
      </label>
    </div>
  );
}

// ─── Screenshot directory ────────────────────────────────────────────────────

export function ScreenshotDirSectionBody() {
  const [cfg, setCfg] = useState<ScreenshotCfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    screenshotGetConfig()
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleChange() {
    setBusy(true);
    setError(null);
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === 'string') {
        await screenshotSetDir(picked);
        setCfg(await screenshotGetConfig());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setBusy(true);
    setError(null);
    try {
      await screenshotSetDir(null);
      setCfg(await screenshotGetConfig());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Where <code>screenshot_window</code> / <code>screenshot_pane</code> save PNGs (also used by
        the global Ctrl+Alt+Shift+S/P shortcuts and the iyke CLI bridge).
      </p>
      <div className="rounded-md border border-border bg-background p-3 text-sm">
        <div className="flex items-start gap-2">
          <Camera className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-mono text-xs break-all">{cfg?.effectiveDir ?? 'Loading…'}</div>
            {cfg && (
              <div className="text-[11px] text-muted-foreground">
                {cfg.overrideDir
                  ? `Custom override (default: ${cfg.defaultDir})`
                  : 'Platform default'}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleChange} disabled={busy}>
          <FolderPlus className="mr-1 h-3.5 w-3.5" />
          Change directory…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={busy || !cfg?.overrideDir}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reset to default
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

// ─── Clear all local data ────────────────────────────────────────────────────

export function ClearDataSectionBody() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClear() {
    const ok = await confirmDialog(
      'This wipes all locally cached app state: chat threads, viewer recents, render queue, mbox sync, storyboards, layout, dock, sequences, and all browser localStorage for this app. Stronghold secrets, screenshots on disk, and your Supabase data are kept. The app will reload.',
      { title: 'Clear all local data', kind: 'warning' }
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // Best-effort: drop SQLite content tables.
      try {
        const db = await Database.load('sqlite:pa.db');
        const tables = [
          'layout_state',
          'viewer_recents',
          'claude_sessions',
          'render_queue',
          'mbox_sync_state',
          'storyboards',
          'storyboard_beats',
          'storyboard_jobs',
          'chat_threads',
          'chat_messages',
        ];
        for (const t of tables) {
          try {
            await db.execute(`DELETE FROM ${t}`);
          } catch (e) {
            // Table may not exist in older installs — ignore.
            console.warn(`[settings] DELETE FROM ${t} failed`, e);
          }
        }
      } catch (e) {
        console.warn('[settings] sqlite unavailable for clear', e);
      }

      // localStorage: nuke everything except auth/theme so the user isn't
      // booted out and the app reopens looking the same.
      const keep = new Set(['ikenga-shell']); // theme store
      const all: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) all.push(k);
      }
      for (const k of all) {
        if (!keep.has(k) && !k.startsWith('sb-')) localStorage.removeItem(k);
      }
      // Also explicitly nuke each known store in case the prefix logic missed.
      for (const k of KNOWN_LOCALSTORAGE_KEYS) {
        if (k !== 'ikenga-shell') localStorage.removeItem(k);
      }

      window.location.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Destructive. Wipes the SQLite cache and all browser localStorage for this app. Auth and
        theme are preserved; Supabase data is untouched.
      </p>
      <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This does not touch Stronghold secrets or screenshot PNGs already written to disk.
          </span>
        </div>
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClear}
          disabled={busy}
          className="text-red-700"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Clear all local data
        </Button>
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      </div>
    </div>
  );
}

// ─── API keys ────────────────────────────────────────────────────────────────

type KeyCategory = {
  label: string;
  keys: Array<{ name: string; hint?: string }>;
};

export const KEY_CATALOG: KeyCategory[] = [
  {
    label: 'LLM',
    keys: [
      { name: 'ANTHROPIC_API_KEY', hint: 'Claude SDK adapter, agents' },
      { name: 'OPENAI_API_KEY', hint: 'Image gen, embeddings' },
    ],
  },
  {
    label: 'Email',
    keys: [
      { name: 'RESEND_API_KEY', hint: 'getroyalti.com cold outreach' },
      { name: 'LISTMONK_API_URL' },
      { name: 'LISTMONK_USERNAME' },
      { name: 'LISTMONK_PASSWORD' },
    ],
  },
  {
    label: 'CRM + DB',
    keys: [
      { name: 'TWENTY_API_URL' },
      { name: 'TWENTY_API_KEY' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', hint: 'Privileged DB access' },
    ],
  },
  {
    label: 'Pkgs (Supabase capability)',
    keys: [
      { name: 'VITE_SUPABASE_URL', hint: 'Shared Supabase URL for pkgs' },
      { name: 'VITE_SUPABASE_ANON_KEY', hint: 'Shared anon key for pkgs' },
    ],
  },
  {
    label: 'Payments',
    keys: [{ name: 'STRIPE_SECRET_KEY' }],
  },
];

export const DOTENV_CANDIDATES = [
  '~/.config/pa-actions/env',
  '~/.config/ikenga/env',
  '~/royalti-co/ikenga/.env',
  '~/royalti-co/ikenga/shell/.env.local',
];

export function ApiKeysSectionBody() {
  const status = useQuery(vaultStatusQueryOptions());
  const keys = useQuery(vaultKeysQueryOptions());
  const [importOpen, setImportOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ key: string; value: string } | null>(null);

  // Auto-mask after timeout.
  useEffect(() => {
    if (!revealedKey) return;
    const t = setTimeout(() => setRevealedKey(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [revealedKey]);

  const known = useMemo(() => new Set(keys.data ?? []), [keys.data]);
  const vaultAvailable = status.data?.available ?? false;

  async function handleReveal(name: string) {
    if (revealedKey?.key === name) {
      setRevealedKey(null);
      return;
    }
    const v = await secretsGet(name);
    if (v != null) setRevealedKey({ key: name, value: v });
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Stored encrypted in your OS keychain. Sidecars read these instead of <code>.env</code> files
        when the app is running.
      </p>

      {/* Vault status banner */}
      {status.data && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-xs',
            vaultAvailable
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200'
              : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200'
          )}
        >
          <div className="flex items-start gap-2">
            {vaultAvailable ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div>
              {vaultAvailable ? (
                <span>Vault unlocked via {status.data.keychainBackend}.</span>
              ) : (
                <span>
                  Vault unavailable: {status.data.error ?? 'unknown error'}. Sidecars will fall back
                  to dotenv files.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import banner */}
      {vaultAvailable && (
        <div className="flex items-center justify-between rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            Import existing keys from <code>~/.config/pa-actions/env</code> or{' '}
            <code>ikenga/.env</code>.
          </span>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Import from dotenv
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {KEY_CATALOG.map((cat) => (
          <div key={cat.label} className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {cat.label}
            </h3>
            <div className="overflow-hidden rounded-md border border-border">
              {cat.keys.map((k, i) => {
                const present = known.has(k.name);
                const isRevealed = revealedKey?.key === k.name;
                return (
                  <div
                    key={k.name}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2',
                      i > 0 && 'border-t border-border'
                    )}
                  >
                    <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-medium">{k.name}</code>
                        {k.hint && (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {k.hint}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {!present ? 'Not set' : isRevealed ? revealedKey.value : '••••••••••••'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {present && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleReveal(k.name)}
                          disabled={!vaultAvailable}
                          title={isRevealed ? 'Hide' : 'Reveal (auto-hides in 30s)'}
                        >
                          {isRevealed ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditKey(k.name)}
                        disabled={!vaultAvailable}
                      >
                        {present ? (
                          <Pencil className="h-3.5 w-3.5" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {editKey && (
        <EditKeyDialog
          keyName={editKey}
          present={known.has(editKey)}
          onClose={() => setEditKey(null)}
        />
      )}
      {importOpen && <ImportDotenvDialog existing={known} onClose={() => setImportOpen(false)} />}
    </div>
  );
}

export function EditKeyDialog({
  keyName,
  present,
  onClose,
}: {
  keyName: string;
  present: boolean;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSecret = useSetSecret();
  const deleteSecret = useDeleteSecret();

  async function handleSave() {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await setSecret.mutateAsync({ key: keyName, value });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirmDialog(`Delete ${keyName} from the vault?`, {
      title: 'Delete key',
      kind: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSecret.mutateAsync(keyName);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{present ? 'Edit' : 'Add'} key</DialogTitle>
          <DialogDescription>
            <code>{keyName}</code> — stored encrypted in {`OS keychain → Stronghold`}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            type="password"
            placeholder={present ? 'Enter new value to replace' : 'Paste value'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
        <DialogFooter className="flex-row sm:justify-between">
          <div>
            {present && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                disabled={busy}
                className="text-red-700"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={busy || !value}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportDotenvDialog({
  existing,
  onClose,
}: {
  existing: Set<string>;
  onClose: () => void;
}) {
  const [paths] = useState<string[]>(DOTENV_CANDIDATES);
  // Default-check only known catalog keys; default-uncheck overwrite of existing.
  const knownKeys = useMemo(() => KEY_CATALOG.flatMap((c) => c.keys.map((k) => k.name)), []);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(knownKeys.filter((k) => !existing.has(k)))
  );
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importMut = useImportDotenv();

  function toggle(k: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    try {
      const r = await importMut.mutateAsync({
        paths,
        keys: Array.from(selected),
        overwrite,
      });
      const missing = r.missingFiles.length
        ? ` (${r.missingFiles.length} file${r.missingFiles.length === 1 ? '' : 's'} not found)`
        : '';
      setResult(`Imported ${r.imported}, skipped ${r.skipped}${missing}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import keys from dotenv</DialogTitle>
          <DialogDescription>
            Scans{' '}
            {paths.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <code>{p}</code>
              </span>
            ))}
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-border p-3">
            {KEY_CATALOG.map((cat) => (
              <div key={cat.label} className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {cat.label}
                </div>
                {cat.keys.map((k) => {
                  const isExisting = existing.has(k.name);
                  return (
                    <label key={k.name} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selected.has(k.name)}
                        onChange={() => toggle(k.name)}
                      />
                      <code>{k.name}</code>
                      {isExisting && (
                        <span className="text-[10px] text-amber-700">(already in vault)</span>
                      )}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite keys already in the vault
          </label>
          {result && <p className="text-xs text-emerald-700">{result}</p>}
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
        <DialogFooter className="flex-row sm:justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button size="sm" onClick={handleImport} disabled={busy || selected.size === 0}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Import {selected.size} key{selected.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
