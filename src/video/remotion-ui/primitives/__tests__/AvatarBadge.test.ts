/**
 * AvatarBadge primitive tests.
 *
 * Tests background resolution, glow logic, and lofi mode behavior.
 */

import { describe, it, expect } from "vitest";
import { defaultPalette, lofiPalette } from "@/video/remotion-ui/themes/brand";
import type { BrandPaletteWithMode } from "@/video/remotion-ui/themes/brand";

// ── Background resolution (mirrors AvatarBadge.tsx logic) ─────────────────

type Background = "solid" | "gradient" | "surface";

function resolveBg(background: Background, palette: BrandPaletteWithMode): string {
  if (palette.lofi) return palette.surface;
  if (background === "gradient") {
    return `radial-gradient(circle at 30% 30%, ${palette.accent}, ${palette.bg} 85%)`;
  }
  if (background === "solid") return palette.accent;
  return palette.surface;
}

function resolveGlow(glow: boolean, palette: BrandPaletteWithMode): string {
  return glow && !palette.lofi ? `0 0 60px ${palette.accent}66` : "none";
}

function resolveGlyphColor(palette: BrandPaletteWithMode): string {
  return palette.lofi ? palette.textPri : palette.highlight;
}

// ── Background tests ────────────────────────────────────────────────────────

describe("AvatarBadge background (hifi)", () => {
  it("gradient background contains palette.accent", () => {
    const bg = resolveBg("gradient", defaultPalette);
    expect(bg).toContain(defaultPalette.accent);
    expect(bg).toContain("radial-gradient");
  });

  it("solid background equals palette.accent flat", () => {
    const bg = resolveBg("solid", defaultPalette);
    expect(bg).toBe(defaultPalette.accent);
    expect(bg).not.toContain("gradient");
  });

  it("surface background equals palette.surface flat", () => {
    const bg = resolveBg("surface", defaultPalette);
    expect(bg).toBe(defaultPalette.surface);
    expect(bg).not.toContain("gradient");
  });

  it("gradient and solid backgrounds differ", () => {
    expect(resolveBg("gradient", defaultPalette)).not.toBe(resolveBg("solid", defaultPalette));
  });
});

// ── Lofi mode ───────────────────────────────────────────────────────────────

describe("AvatarBadge lofi mode", () => {
  it("all background types collapse to lofi surface", () => {
    expect(resolveBg("gradient", lofiPalette)).toBe(lofiPalette.surface);
    expect(resolveBg("solid", lofiPalette)).toBe(lofiPalette.surface);
    expect(resolveBg("surface", lofiPalette)).toBe(lofiPalette.surface);
  });

  it("glow is suppressed (returns 'none') even when glow=true in lofi", () => {
    expect(resolveGlow(true, lofiPalette)).toBe("none");
  });

  it("glyph color is textPri in lofi (not highlight)", () => {
    expect(resolveGlyphColor(lofiPalette)).toBe(lofiPalette.textPri);
    expect(resolveGlyphColor(lofiPalette)).not.toBe(lofiPalette.highlight);
  });
});

// ── Glow (hifi) ─────────────────────────────────────────────────────────────

describe("AvatarBadge glow (hifi)", () => {
  it("glow=true in hifi produces a box-shadow string", () => {
    const shadow = resolveGlow(true, defaultPalette);
    expect(shadow).not.toBe("none");
    expect(shadow).toContain(defaultPalette.accent);
  });

  it("glow=false in hifi returns 'none'", () => {
    expect(resolveGlow(false, defaultPalette)).toBe("none");
  });

  it("glyph color is highlight in hifi", () => {
    expect(resolveGlyphColor(defaultPalette)).toBe(defaultPalette.highlight);
  });
});
