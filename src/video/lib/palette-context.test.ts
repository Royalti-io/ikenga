import { describe, it, expect } from "vitest";
import {
  DEFAULT_PALETTE,
  mergePalette,
  type Palette,
  type PaletteOverride,
} from "./palette-context";

// Vitest is configured with `environment: node`, and the project does not
// ship react-test-renderer / @testing-library/react. The PaletteProvider's
// only behavior beyond `<Context.Provider>` is computing
// `mergePalette(parentContextValue, value)`, so testing `mergePalette` directly
// covers the provider's merge contract — including the nested (root → section)
// case, which is just `mergePalette(mergePalette(DEFAULT, root), section)`.

describe("DEFAULT_PALETTE", () => {
  it("matches snapshot", () => {
    expect(DEFAULT_PALETTE).toMatchInlineSnapshot(`
      {
        "accent": "#006666",
        "accentMuted": "#2A7B7B",
        "bg": "#0D0D0D",
        "border": "#1F1F1F",
        "highlight": "#006666",
        "info": "#3B82F6",
        "success": "#10B981",
        "surface": "#0D0D0D",
        "textPri": "#F8FAFC",
        "textSec": "#8899AA",
        "warning": "#F59E0B",
      }
    `);
  });

  it("has all 11 required keys", () => {
    const expectedKeys: Array<keyof Palette> = [
      "bg",
      "surface",
      "border",
      "accent",
      "accentMuted",
      "highlight",
      "textPri",
      "textSec",
      "success",
      "warning",
      "info",
    ];
    for (const key of expectedKeys) {
      expect(typeof DEFAULT_PALETTE[key]).toBe("string");
      expect(DEFAULT_PALETTE[key].length).toBeGreaterThan(0);
    }
  });
});

describe("mergePalette (PaletteProvider merge contract)", () => {
  it("returns base when override is undefined or null", () => {
    expect(mergePalette(DEFAULT_PALETTE, undefined)).toEqual(DEFAULT_PALETTE);
    expect(mergePalette(DEFAULT_PALETTE, null)).toEqual(DEFAULT_PALETTE);
  });

  it("partial override only changes the specified key", () => {
    const merged = mergePalette(DEFAULT_PALETTE, { accent: "#ff0000" });
    expect(merged.accent).toBe("#ff0000");
    // Every other key falls through unchanged.
    for (const key of Object.keys(DEFAULT_PALETTE) as Array<keyof Palette>) {
      if (key === "accent") continue;
      expect(merged[key]).toBe(DEFAULT_PALETTE[key]);
    }
  });

  it("ignores empty-string overrides (treated as unset)", () => {
    const merged = mergePalette(DEFAULT_PALETTE, { accent: "" });
    expect(merged.accent).toBe(DEFAULT_PALETTE.accent);
  });

  it("nested merge: section override wins, unset section keys fall through to root", () => {
    const rootOverride: PaletteOverride = {
      accent: "#66cccc", // sub-brand teal
      bg: "#002626", // dark teal background
    };
    const sectionOverride: PaletteOverride = {
      accent: "#ff8800", // section overrides accent only
    };
    // Mirror the React tree: DEFAULT → root provider → section provider.
    const afterRoot = mergePalette(DEFAULT_PALETTE, rootOverride);
    const afterSection = mergePalette(afterRoot, sectionOverride);

    // Section override wins.
    expect(afterSection.accent).toBe("#ff8800");
    // Root override survives where section didn't override.
    expect(afterSection.bg).toBe("#002626");
    // Unset-everywhere keys fall through to DEFAULT_PALETTE.
    expect(afterSection.textPri).toBe(DEFAULT_PALETTE.textPri);
    expect(afterSection.success).toBe(DEFAULT_PALETTE.success);
  });
});
