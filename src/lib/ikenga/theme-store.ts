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

/** Light/dark switch. The shell-default is dark. */
export type IkengaMode = 'light' | 'dark';

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

/** Subscribe the store to <html> data-attribute writes. Call once at app
 *  bootstrap (from `main.tsx`). Idempotent — second calls are no-ops. */
export function installIkengaDomSync() {
  if (installed) return;
  installed = true;
  if (typeof document === 'undefined') return;
  const apply = (s: IkengaState) => {
    const html = document.documentElement;
    html.setAttribute('data-theme', s.theme);
    html.setAttribute('data-mode', s.mode);
    html.setAttribute('data-density', s.density);
    html.setAttribute('data-tint-strength', s.tintStrength);
    html.setAttribute('data-workspace', s.workspace);
  };
  apply(useIkengaStore.getState());
  useIkengaStore.subscribe(apply);
}
