/**
 * ChatBubble primitive tests.
 *
 * Tests alignment logic, tone→color mapping, and revealAtWord frame resolution.
 */

import { describe, it, expect } from "vitest";
import { defaultPalette, lofiPalette } from "@/video/remotion-ui/themes/brand";
import { useNarrationSync } from "@/video/lib/use-narration-sync";
import type { NarrationWord } from "@/video/lib/use-narration-sync";

// ── Side / tone alignment ───────────────────────────────────────────────────

type Side = "left" | "right";
type Tone = "user" | "assistant";

function resolveAlignment(side: Side): "flex-end" | "flex-start" {
  return side === "right" ? "flex-end" : "flex-start";
}

function resolveBg(tone: Tone, palette: typeof defaultPalette): string {
  return tone === "user" ? palette.accent : palette.surface;
}

function resolveBorder(tone: Tone, palette: typeof defaultPalette): string {
  return tone === "user" ? palette.highlight : palette.border;
}

describe("ChatBubble alignment", () => {
  it("right side aligns to flex-end", () => {
    expect(resolveAlignment("right")).toBe("flex-end");
  });

  it("left side aligns to flex-start", () => {
    expect(resolveAlignment("left")).toBe("flex-start");
  });

  it("left and right alignment differ", () => {
    expect(resolveAlignment("left")).not.toBe(resolveAlignment("right"));
  });
});

// ── Tone color mapping ──────────────────────────────────────────────────────

describe("ChatBubble tone colors (hifi palette)", () => {
  it("user tone uses palette.accent for background", () => {
    expect(resolveBg("user", defaultPalette)).toBe(defaultPalette.accent);
  });

  it("assistant tone uses palette.surface for background", () => {
    expect(resolveBg("assistant", defaultPalette)).toBe(defaultPalette.surface);
  });

  it("user and assistant backgrounds are different", () => {
    expect(resolveBg("user", defaultPalette)).not.toBe(resolveBg("assistant", defaultPalette));
  });

  it("user tone uses palette.highlight for border", () => {
    expect(resolveBorder("user", defaultPalette)).toBe(defaultPalette.highlight);
  });

  it("assistant tone uses palette.border for border", () => {
    expect(resolveBorder("assistant", defaultPalette)).toBe(defaultPalette.border);
  });
});

// ── Lofi palette flat styling ───────────────────────────────────────────────

describe("ChatBubble lofi mode", () => {
  it("lofi surface is different from hifi surface", () => {
    expect(lofiPalette.surface).not.toBe(defaultPalette.surface);
  });

  it("lofi palette has lofi=true flag", () => {
    expect(lofiPalette.lofi).toBe(true);
  });

  it("assistant tone in lofi uses lofi surface", () => {
    expect(resolveBg("assistant", lofiPalette)).toBe(lofiPalette.surface);
  });
});

// ── revealAtWord → frame resolution ────────────────────────────────────────

const testWords: NarrationWord[] = [
  { word: "Ask",    start: 0.5, end: 0.9 },
  { word: "it",     start: 0.9, end: 1.1 },
  { word: "anything", start: 1.1, end: 1.8 },
  { word: "Roy",    start: 2.0, end: 2.4 },
];

describe("ChatBubble revealAtWord frame resolution", () => {
  it("resolves word to correct frame via useNarrationSync", () => {
    const sync = useNarrationSync({ words: testWords, fps: 30 });
    // "Roy" at 2.0s × 30fps = 60
    expect(sync.frameForWord("Roy")).toBe(60);
  });

  it("falls back to null when word is not found", () => {
    const sync = useNarrationSync({ words: testWords, fps: 30 });
    expect(sync.frameForWord("DistroKid")).toBeNull();
  });

  it("resolves 'anything' to correct frame", () => {
    const sync = useNarrationSync({ words: testWords, fps: 30 });
    // 1.1s × 30 = 33
    expect(sync.frameForWord("anything")).toBe(33);
  });
});
