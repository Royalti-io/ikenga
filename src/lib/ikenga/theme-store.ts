// Ikenga theme/mode/density/workspace store.
//
// Drives the data-* attribute set on <html> that @ikenga/tokens reads.
// Reconstructed 2026-05-06 — earlier history of this file was not present
// in the working tree at the Tasks-pkg cutover; this version restores the
// surface every existing consumer expects:
//
//   - useIkengaStore  (zustand store)
//   - installIkengaDomSync()  (one-time DOM-sync subscription)
//   - types: IkengaTheme, IkengaMode, IkengaDensity, IkengaTintStrength,
//            IkengaWorkspace

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Palette variants. A=default (Iroko/dusk), B=Kola amber, C=verdigris. */
export type IkengaTheme = 'A' | 'B' | 'C';

/** Light/dark switch. The shell-default is dark.
 *
 * 'system' tracks the OS preference via `matchMedia` (installed by
 * `installIkengaDomSync`). The persisted store value stays 'system';
 * only the resolved `<html data-mode>` attribute flips between
 * light/dark in response to the media query. */
export type IkengaMode = 'light' | 'dark' | 'system';

/** The mode actually written to the DOM (i.e. 'system' resolved to
 * either 'light' or 'dark'). */
export type ResolvedIkengaMode = 'light' | 'dark';

/** Row height + body font density. */
export type IkengaDensity = 'compact' | 'comfortable' | 'spacious';

/** How aggressive the workspace tint reads on chrome. */
export type IkengaTintStrength = 'off' | 'subtle' | 'strong';

/** First-class workspaces post-strip. Old tints (mail/outbox/studio/
 *  agents) stay as dormant CSS variables in the design tokens for any
 *  pkg that wants to opt into them, but the type union doesn't carry
 *  them anymore. */
export type IkengaWorkspace = 'app' | 'files' | 'sessions' | 'settings';

interface IkengaState {
  theme: IkengaTheme;
  mode: IkengaMode;
  density: IkengaDensity;
  tintStrength: IkengaTintStrength;
  workspace: IkengaWorkspace;
  setTheme: (t: IkengaTheme) => void;
  setMode: (m: IkengaMode) => void;
  setDensity: (d: IkengaDensity) => void;
  setTintStrength: (s: IkengaTintStrength) => void;
  setWorkspace: (w: IkengaWorkspace) => void;
}

export const useIkengaStore = create<IkengaState>()(
  persist(
    (set) => ({
      theme: 'A',
      mode: 'dark',
      density: 'comfortable',
      tintStrength: 'subtle',
      workspace: 'app',
      setTheme: (theme) => set({ theme }),
      setMode: (mode) => set({ mode }),
      setDensity: (density) => set({ density }),
      setTintStrength: (tintStrength) => set({ tintStrength }),
      setWorkspace: (workspace) => set({ workspace }),
    }),
    {
      name: 'ikenga.theme',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);

let installed = false;

/** Resolve a store mode (which may be 'system') to the literal mode
 *  written into `<html data-mode>`. Exported for unit tests. */
export function resolveIkengaMode(
  mode: IkengaMode,
  prefersDark: boolean,
): ResolvedIkengaMode {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** Subscribe the store to <html> data-attribute writes. Call once at app
 *  bootstrap (from `main.tsx`). Idempotent — second calls are no-ops.
 *
 *  When `mode === 'system'` the resolved attribute follows the OS
 *  `prefers-color-scheme` query and re-applies on `change`. The store
 *  itself still persists 'system' so the preference survives reload. */
export function installIkengaDomSync() {
  if (installed) return;
  installed = true;
  if (typeof document === 'undefined') return;

  // Prefer-dark media query. Safari < 14 lacks `addEventListener` on
  // MediaQueryList — fall back to the deprecated addListener.
  const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  const apply = (s: IkengaState) => {
    const html = document.documentElement;
    const prefersDark = !!mql?.matches;
    const resolved = resolveIkengaMode(s.mode, prefersDark);
    html.setAttribute('data-theme', s.theme);
    html.setAttribute('data-mode', resolved);
    html.setAttribute('data-mode-source', s.mode); // 'light' | 'dark' | 'system'
    html.setAttribute('data-density', s.density);
    html.setAttribute('data-tint-strength', s.tintStrength);
    html.setAttribute('data-workspace', s.workspace);
  };

  apply(useIkengaStore.getState());
  useIkengaStore.subscribe(apply);

  if (mql) {
    const onChange = () => apply(useIkengaStore.getState());
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
    } else if (typeof (mql as MediaQueryList & {
      addListener?: (l: () => void) => void;
    }).addListener === 'function') {
      (mql as MediaQueryList & { addListener: (l: () => void) => void }).addListener(onChange);
    }
  }
}
