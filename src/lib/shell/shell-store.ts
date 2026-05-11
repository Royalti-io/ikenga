import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Post-strip: only 4 first-class workspaces. Mail / Outbox / Studio /
// Agents were app-pkg surfaces and got removed with the strip-down.
// Mini-apps are gone too — they were placeholders for media tooling
// that lives in app pkgs now.
export type CoreMode = 'app' | 'files' | 'sessions' | 'settings';
export type ActivityMode = CoreMode;

// Default file roots match the Tauri capability allowlist in
// `src-tauri/capabilities/default.json`. Reads outside these paths fail
// regardless of what the user adds via Settings — we surface that warning
// in the editor.
export const DEFAULT_FILE_ROOTS: readonly string[] = Object.freeze([
  '~/royalti-co',
  '~/.company',
  '~/.claude/projects',
]);

// Project roots scanned by the /claude config browser. Each root is a dir
// that contains a `.claude/` subfolder (agents/skills/commands/settings).
// Personal `~/.claude/` is always scanned in addition to these — it doesn't
// need to be listed.
export const DEFAULT_CLAUDE_PROJECT_ROOTS: readonly string[] = Object.freeze(['~/royalti-co']);

interface ShellState {
  activeMode: ActivityMode;
  setActiveMode: (m: ActivityMode) => void;

  fileRoots: string[];
  addFileRoot: (path: string) => void;
  removeFileRoot: (path: string) => void;
  /** Replace `oldPath` with `newPath` (no-op if oldPath isn't present, or if
   * the new path is empty / a duplicate of an existing entry). Used by the
   * editable settings selectors. */
  updateFileRoot: (oldPath: string, newPath: string) => void;
  resetFileRoots: () => void;

  claudeProjectRoots: string[];
  addClaudeProjectRoot: (path: string) => void;
  removeClaudeProjectRoot: (path: string) => void;
  updateClaudeProjectRoot: (oldPath: string, newPath: string) => void;
  resetClaudeProjectRoots: () => void;
  claudeWatchEnabled: boolean;
  setClaudeWatchEnabled: (enabled: boolean) => void;
}

export const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      activeMode: 'app',
      setActiveMode: (activeMode) => set({ activeMode }),

      fileRoots: [...DEFAULT_FILE_ROOTS],
      addFileRoot: (path) => {
        const trimmed = path.trim();
        if (!trimmed) return;
        if (get().fileRoots.includes(trimmed)) return;
        set({ fileRoots: [...get().fileRoots, trimmed] });
      },
      removeFileRoot: (path) => set({ fileRoots: get().fileRoots.filter((r) => r !== path) }),
      updateFileRoot: (oldPath, newPath) => {
        const trimmed = newPath.trim();
        if (!trimmed || trimmed === oldPath) return;
        const cur = get().fileRoots;
        const idx = cur.indexOf(oldPath);
        if (idx < 0) return;
        // Don't allow renaming on top of another existing entry.
        if (cur.includes(trimmed)) return;
        const next = [...cur];
        next[idx] = trimmed;
        set({ fileRoots: next });
      },
      resetFileRoots: () => set({ fileRoots: [...DEFAULT_FILE_ROOTS] }),

      claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS],
      addClaudeProjectRoot: (path) => {
        const trimmed = path.trim();
        if (!trimmed) return;
        if (get().claudeProjectRoots.includes(trimmed)) return;
        set({ claudeProjectRoots: [...get().claudeProjectRoots, trimmed] });
      },
      removeClaudeProjectRoot: (path) =>
        set({ claudeProjectRoots: get().claudeProjectRoots.filter((r) => r !== path) }),
      updateClaudeProjectRoot: (oldPath, newPath) => {
        const trimmed = newPath.trim();
        if (!trimmed || trimmed === oldPath) return;
        const cur = get().claudeProjectRoots;
        const idx = cur.indexOf(oldPath);
        if (idx < 0) return;
        if (cur.includes(trimmed)) return;
        const next = [...cur];
        next[idx] = trimmed;
        set({ claudeProjectRoots: next });
      },
      resetClaudeProjectRoots: () => set({ claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS] }),
      claudeWatchEnabled: true,
      setClaudeWatchEnabled: (claudeWatchEnabled) => set({ claudeWatchEnabled }),
    }),
    // Bump version when ActivityMode union or persisted shape changes.
    // v5: mail/outbox/studio promoted to CoreMode (then v7 narrowed).
    // v6: added claudeProjectRoots / claudeWatchEnabled.
    // v7: strip-down — CoreMode narrowed to {app, files, sessions, settings};
    //     migrate snaps any stale persisted activeMode (mail/outbox/studio/
    //     agents/mini-app names) → 'app' so users coming from the legacy
    //     shell don't crash on an invalid persisted union value.
    {
      name: 'shell-store',
      version: 7,
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as Partial<ShellState> & {
          activeMode?: string;
        };
        const valid: ActivityMode[] = ['app', 'files', 'sessions', 'settings'];
        if (p.activeMode && !valid.includes(p.activeMode as ActivityMode)) {
          p.activeMode = 'app';
        }
        return p as ShellState;
      },
    }
  )
);
