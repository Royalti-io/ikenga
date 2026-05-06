// Backwards-compat shim over the Ikenga theme store. Existing call-sites
// (settings page, code-view, markdown) use `{ theme, setTheme, resolvedTheme }`
// where `theme` ∈ 'light' | 'dark'. We forward those onto Ikenga's `mode`.
//
// Full theme/density/workspace controls land in Batch 5 (settings page) via
// `useIkengaStore` directly.
import { useIkengaStore, type IkengaMode } from './ikenga/theme-store';

type LegacyTheme = IkengaMode | 'system';

export function useTheme() {
  const mode = useIkengaStore((s) => s.mode);
  const setMode = useIkengaStore((s) => s.setMode);
  return {
    theme: mode as LegacyTheme,
    resolvedTheme: mode,
    setTheme: (t: LegacyTheme) => {
      // Ikenga has no 'system' mode; fall back to dark (the default install).
      setMode(t === 'system' ? 'dark' : t);
    },
  };
}

export { useIkengaStore } from './ikenga/theme-store';
