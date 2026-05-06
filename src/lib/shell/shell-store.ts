import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Ikenga locks 7 first-class workspaces + Settings (design/system/tokens.md §1).
// Mail / Outbox / Studio promoted from sub-routes / mini-apps to cores.
export type CoreMode =
  | 'app'
  | 'mail'
  | 'outbox'
  | 'studio'
  | 'agents'
  | 'files'
  | 'sessions'
  | 'settings';
export type MiniAppMode =
  | 'storyboard'
  | 'video-engine'
  | 'hyperframes'
  | 'canvas-design'
  | 'image-generator';
export type ActivityMode = CoreMode | MiniAppMode;

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
export const DEFAULT_CLAUDE_PROJECT_ROOTS: readonly string[] = Object.freeze([
  '~/royalti-co',
]);

interface ShellState {
  activeMode: ActivityMode;
  setActiveMode: (m: ActivityMode) => void;

  fileRoots: string[];
  addFileRoot: (path: string) => void;
  removeFileRoot: (path: string) => void;
  resetFileRoots: () => void;

  claudeProjectRoots: string[];
  addClaudeProjectRoot: (path: string) => void;
  removeClaudeProjectRoot: (path: string) => void;
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
      removeFileRoot: (path) =>
        set({ fileRoots: get().fileRoots.filter((r) => r !== path) }),
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
      resetClaudeProjectRoots: () =>
        set({ claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS] }),
      claudeWatchEnabled: true,
      setClaudeWatchEnabled: (claudeWatchEnabled) => set({ claudeWatchEnabled }),
    }),
    // Bump version when ActivityMode union or persisted shape changes.
    // v5: mail/outbox/studio promoted to CoreMode. Stale persisted activeMode
    //     values still map cleanly because the union widened, not narrowed.
    // v6: added claudeProjectRoots / claudeWatchEnabled.
    { name: 'shell-store', version: 6 },
  ),
);
