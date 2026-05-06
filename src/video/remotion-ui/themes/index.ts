export { ThemeProvider, useTheme, type ThemeProviderProps } from "./ThemeProvider";
export { royaltiTheme, type ThemeTokens } from "./tokens";
export { PRESETS, type AspectPreset, type SafeArea } from "./presets";

// ── Freeform Phase 1 additions ─────────────────────────────────────────────
export {
  type BrandPalette,
  type BrandPaletteWithMode,
  defaultPalette,
  lofiPalette,
} from "./brand";
export {
  BrandProvider,
  usePalette,
  type BrandProviderProps,
} from "./BrandProvider";
export {
  StoryboardProvider,
  useStoryboard,
  type StoryboardProviderProps,
  type StoryboardContextValue,
  type NarrationManifest,
  type NarrationWord,
} from "./StoryboardProvider";
