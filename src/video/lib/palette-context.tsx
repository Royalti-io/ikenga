/**
 * PaletteContext — per-clip + per-section palette overrides.
 *
 * Implements Gap C of ADR-001 (incremental opt-in plumbing).
 *
 * Defaults are derived from the canonical `VIDEO_COLORS` and `BRAND` constants
 * in `config/defaults.ts`, so existing components that still import those
 * directly continue to render byte-identically. New / migrated components can
 * call `usePalette()` to read the merged palette and respect script-level
 * (`videoMetadataSchema.palette`) and section-level (`sectionSchema.palette`)
 * overrides.
 *
 * Merge semantics: the inner `<PaletteProvider>` merges its `value` over the
 * surrounding context, so partial overrides work and unset keys fall through
 * to the parent. Wrap composition root for script-level overrides; wrap each
 * section render for per-section overrides.
 */

import React from "react";
import { BRAND, VIDEO_COLORS } from "../config/defaults";

// ── Types ────────────────────────────────────────────────────────────────

export interface Palette {
  bg: string;
  surface: string;
  border: string;
  accent: string;
  accentMuted: string;
  highlight: string;
  textPri: string;
  textSec: string;
  success: string;
  warning: string;
  info: string;
}

/** Partial palette — used as the override `value` on `PaletteProvider`. */
export type PaletteOverride = Partial<Palette>;

// ── Defaults ─────────────────────────────────────────────────────────────

/**
 * Default palette derived from the existing `VIDEO_COLORS` + `BRAND` constants.
 * Keep this in lock-step with `config/defaults.ts` so unmigrated components
 * (which still import VIDEO_COLORS/BRAND directly) match `usePalette()` output.
 */
export const DEFAULT_PALETTE: Palette = {
  bg: VIDEO_COLORS.background,
  surface: VIDEO_COLORS.background,
  border: VIDEO_COLORS.border,
  accent: BRAND.primary,
  accentMuted: BRAND.gradientFrom,
  highlight: BRAND.primary,
  textPri: VIDEO_COLORS.text,
  textSec: VIDEO_COLORS.mutedText,
  success: VIDEO_COLORS.success,
  warning: VIDEO_COLORS.warning,
  info: VIDEO_COLORS.info,
};

// ── Pure merge helper (exported for tests + non-React callers) ───────────

/**
 * Merge a partial palette over a base palette. Unset / undefined keys fall
 * through to the base. Pure function — safe to use in tests, scene-builder,
 * etc. without a React tree.
 */
export function mergePalette(
  base: Palette,
  override?: PaletteOverride | null,
): Palette {
  if (!override) return base;
  const out: Palette = { ...base };
  for (const key of Object.keys(override) as Array<keyof Palette>) {
    const v = override[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = v;
    }
  }
  return out;
}

// ── React context ────────────────────────────────────────────────────────

export const PaletteContext = React.createContext<Palette>(DEFAULT_PALETTE);

export interface PaletteProviderProps {
  value?: PaletteOverride | null;
  children: React.ReactNode;
}

/**
 * Wraps children in a palette context that merges `value` over the surrounding
 * context (or `DEFAULT_PALETTE` at the root). Partial overrides are supported —
 * any unset key falls through to the parent.
 */
export const PaletteProvider: React.FC<PaletteProviderProps> = ({
  value,
  children,
}) => {
  const parent = React.useContext(PaletteContext);
  const merged = React.useMemo(
    () => mergePalette(parent, value),
    [parent, value],
  );
  return (
    <PaletteContext.Provider value={merged}>{children}</PaletteContext.Provider>
  );
};

/** Hook returning the merged palette for the current subtree. */
export function usePalette(): Palette {
  return React.useContext(PaletteContext);
}
