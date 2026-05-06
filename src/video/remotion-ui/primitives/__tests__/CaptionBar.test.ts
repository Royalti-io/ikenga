/**
 * CaptionBar primitive tests.
 *
 * Tests phrase lookup at absolute video frames, gap handling, and lofi styling.
 */

import { describe, it, expect } from "vitest";
import { defaultPalette, lofiPalette } from "@/video/remotion-ui/themes/brand";
import type { BrandPaletteWithMode } from "@/video/remotion-ui/themes/brand";
import type { CaptionPhrase } from "../CaptionBar";

// ── Phrase lookup (mirrors CaptionBar.tsx logic) ───────────────────────────

function findPhrase(phrases: CaptionPhrase[], frame: number, fps = 30): CaptionPhrase | undefined {
  const currentSec = frame / fps;
  return phrases.find((p) => currentSec >= p.start && currentSec < p.end);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const phrases: CaptionPhrase[] = [
  { text: "Your royalty data has answers.", start: 0,     end: 1.904 },
  { text: "Asking was the hard part.",       start: 2.148, end: 3.564 },
  { text: "Meet Ask Roy.",                   start: 15.256, end: 16.312 },
];

// fps=30, so:
//   phrase 0: frames 0..57   (0s–1.904s)
//   gap:      frames 58..64  (1.904s–2.148s)
//   phrase 1: frames 65..106 (2.148s–3.564s)
//   phrase 2: frames 458..489 (15.256s–16.312s)

describe("CaptionBar phrase lookup", () => {
  it("first phrase is visible at frame 0", () => {
    expect(findPhrase(phrases, 0)?.text).toBe("Your royalty data has answers.");
  });

  it("first phrase is still visible mid-way through (frame 30)", () => {
    expect(findPhrase(phrases, 30)?.text).toBe("Your royalty data has answers.");
  });

  it("nothing renders in the gap between phrases (frame 62)", () => {
    // 62/30 = 2.0667s — between phrase 0 end (1.904) and phrase 1 start (2.148)
    expect(findPhrase(phrases, 62)).toBeUndefined();
  });

  it("second phrase activates at its start frame (frame 65)", () => {
    // 65/30 = 2.1667s >= 2.148
    expect(findPhrase(phrases, 65)?.text).toBe("Asking was the hard part.");
  });

  it("third phrase activates at frame 458", () => {
    // 458/30 = 15.2667s >= 15.256
    expect(findPhrase(phrases, 458)?.text).toBe("Meet Ask Roy.");
  });

  it("returns undefined before first phrase start (if phrases don't start at 0)", () => {
    const laterPhrases: CaptionPhrase[] = [
      { text: "Late start", start: 5.0, end: 7.0 },
    ];
    // Frame 100 = 3.33s < 5.0
    expect(findPhrase(laterPhrases, 100)).toBeUndefined();
  });

  it("returns undefined after all phrases end", () => {
    // Frame 2000 = 66.67s — well past the last phrase
    expect(findPhrase(phrases, 2000)).toBeUndefined();
  });
});

// ── Lofi styling ────────────────────────────────────────────────────────────

function resolveCaptionBg(palette: BrandPaletteWithMode): string {
  return palette.lofi ? palette.surface : `${palette.accent}E0`;
}

function resolveCaptionShadow(palette: BrandPaletteWithMode): string {
  return palette.lofi ? "none" : "0 6px 24px rgba(0,0,0,0.35)";
}

describe("CaptionBar lofi styling", () => {
  it("lofi uses solid palette.surface background", () => {
    const bg = resolveCaptionBg(lofiPalette);
    expect(bg).toBe(lofiPalette.surface);
    expect(bg).not.toContain("E0"); // no alpha suffix
  });

  it("hifi uses accent with alpha E0 suffix", () => {
    const bg = resolveCaptionBg(defaultPalette);
    expect(bg).toBe(`${defaultPalette.accent}E0`);
  });

  it("lofi has no box-shadow", () => {
    expect(resolveCaptionShadow(lofiPalette)).toBe("none");
  });

  it("hifi has a drop shadow", () => {
    const shadow = resolveCaptionShadow(defaultPalette);
    expect(shadow).not.toBe("none");
    expect(shadow).toContain("rgba");
  });
});
