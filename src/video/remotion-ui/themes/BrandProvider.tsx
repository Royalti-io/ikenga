/**
 * BrandProvider — React context provider for the active BrandPalette.
 *
 * Usage:
 *   <BrandProvider palette={myPalette}>
 *     <MyComposition />
 *   </BrandProvider>
 *
 * When `palette.lofi` is true (or the `lofi` prop is set to true) the provider
 * automatically substitutes the wireframe-grayscale lofiPalette so that
 * primitives down the tree can skip glows/gradients and render fast stills for
 * Rung 1 beat-sheet review.
 *
 * `usePalette()` returns the full BrandPaletteWithMode including the `lofi`
 * flag so primitives can gate effects:
 *
 *   const palette = usePalette();
 *   const glow = palette.lofi ? "none" : `0 0 40px ${palette.accent}66`;
 *
 * Nesting: inner BrandProvider takes precedence — this allows a composition to
 * override palette for a specific sub-tree (e.g. a spotlight moment in a
 * different accent colour).
 */

import React, { createContext, useContext, useMemo } from "react";
import { type BrandPaletteWithMode, defaultPalette, lofiPalette } from "./brand";

// ── Context ────────────────────────────────────────────────────────────────

const BrandContext = createContext<BrandPaletteWithMode>(defaultPalette);

// ── Provider ───────────────────────────────────────────────────────────────

export interface BrandProviderProps {
  /**
   * The palette to expose to all children. Defaults to `defaultPalette` (dark
   * teal Ask Roy palette). If omitted, children inherit from the nearest
   * ancestor BrandProvider (or the default palette at the root).
   */
  palette?: BrandPaletteWithMode;
  /**
   * Convenience shorthand: setting `lofi={true}` is equivalent to wrapping
   * with the lofiPalette regardless of what `palette` says. Takes precedence
   * over `palette.lofi`.
   */
  lofi?: boolean;
  children: React.ReactNode;
}

export const BrandProvider: React.FC<BrandProviderProps> = ({
  palette,
  lofi,
  children,
}) => {
  const resolved = useMemo<BrandPaletteWithMode>(() => {
    // Explicit `lofi` prop takes highest priority
    const isLofi = lofi === true || palette?.lofi === true;
    if (isLofi) return lofiPalette;
    return palette ?? defaultPalette;
  }, [palette, lofi]);

  return (
    <BrandContext.Provider value={resolved}>{children}</BrandContext.Provider>
  );
};

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Returns the BrandPaletteWithMode from the nearest BrandProvider ancestor.
 * Falls back to `defaultPalette` if no provider is present.
 *
 * Always includes `lofi` (boolean | undefined) — primitives should check:
 *   if (!palette.lofi) { apply glow / gradient }
 */
export function usePalette(): BrandPaletteWithMode {
  return useContext(BrandContext);
}
