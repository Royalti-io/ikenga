// Backwards-compat shim over the Ikenga theme store. Existing call-sites
// (settings page, code-view, markdown) use `{ theme, setTheme, resolvedTheme }`
// where `theme` ∈ 'light' | 'dark' | 'system'. We forward onto Ikenga's
// `mode` directly now that the store supports 'system'.
//
// Full theme/density/workspace controls land in Batch 5 (settings page) via
// `useIkengaStore` directly.
import { useIkengaStore, type IkengaMode } from './ikenga/theme-store';

export function useTheme() {
  const mode = useIkengaStore((s) => s.mode);
  const setMode = useIkengaStore((s) => s.setMode);
  // resolvedTheme is the effective light/dark — when mode is 'system' we
  // mirror the OS preference (browser-only; falls back to dark in SSR).
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true;
  const resolvedTheme: 'light' | 'dark' =
    mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  return {
    theme: mode,
    resolvedTheme,
    setTheme: (t: IkengaMode) => setMode(t),
  };
}

export { useIkengaStore } from './ikenga/theme-store';
