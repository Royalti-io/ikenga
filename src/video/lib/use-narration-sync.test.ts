/**
 * Tests for useNarrationSync() — word lookup, occurrence index, frameForSecond.
 */

import { describe, it, expect } from "vitest";
import { useNarrationSync, type NarrationWord } from "./use-narration-sync";

// ── Fixtures ────────────────────────────────────────────────────────────────

const words: NarrationWord[] = [
  { word: "Your",   start: 0.0,  end: 0.3  },
  { word: "royalty", start: 0.3, end: 0.9  },
  { word: "data",   start: 0.9,  end: 1.2  },
  { word: "has",    start: 1.2,  end: 1.5  },
  { word: "answers", start: 1.5, end: 2.1  },
  { word: "the",    start: 2.2,  end: 2.4  },
  { word: "answer", start: 2.4,  end: 2.9  },
  { word: "is",     start: 2.9,  end: 3.1  },
  { word: "the",    start: 3.1,  end: 3.3  }, // second "the"
  { word: "same",   start: 3.3,  end: 3.7  },
  { word: "Roy,",   start: 3.8,  end: 4.2  }, // punctuation-trimmed → "Roy"
];

const sync = useNarrationSync({ words, fps: 30 });

// ── frameForWord ────────────────────────────────────────────────────────────

describe("useNarrationSync.frameForWord", () => {
  it("returns frame for first occurrence by default", () => {
    // "the" first at 2.2s × 30fps = 66
    expect(sync.frameForWord("the")).toBe(66);
  });

  it("returns frame for second occurrence when occurrence=2", () => {
    // "the" second at 3.1s × 30fps = 93
    expect(sync.frameForWord("the", 2)).toBe(93);
  });

  it("returns null for a word that does not exist", () => {
    expect(sync.frameForWord("DistroKid")).toBeNull();
  });

  it("returns null when occurrence index exceeds count", () => {
    // Only 2 occurrences of "the"
    expect(sync.frameForWord("the", 3)).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(sync.frameForWord("YOUR")).toBe(sync.frameForWord("your"));
    expect(sync.frameForWord("YOUR")).toBe(0); // 0.0s × 30 = 0
  });

  it("strips trailing punctuation for matching", () => {
    // "Roy," in words array → should match "Roy"
    expect(sync.frameForWord("Roy")).toBe(114); // 3.8s × 30 = 114
  });

  it("floors fractional frame results", () => {
    // 0.3s × 30 = 9.0 (exact) — but ensure no rounding up
    const sync2 = useNarrationSync({
      words: [{ word: "test", start: 0.333, end: 0.666 }],
      fps: 30,
    });
    // 0.333 × 30 = 9.99 → floor = 9
    expect(sync2.frameForWord("test")).toBe(9);
  });
});

// ── frameForSecond ──────────────────────────────────────────────────────────

describe("useNarrationSync.frameForSecond", () => {
  it("converts seconds to frames via floor(s × fps)", () => {
    expect(sync.frameForSecond(0)).toBe(0);
    expect(sync.frameForSecond(1)).toBe(30);
    expect(sync.frameForSecond(15.256)).toBe(457); // floor(15.256 × 30)
  });

  it("respects custom fps", () => {
    const sync60 = useNarrationSync({ words: [], fps: 60 });
    expect(sync60.frameForSecond(1)).toBe(60);
  });
});

// ── fps property ────────────────────────────────────────────────────────────

describe("useNarrationSync.fps", () => {
  it("defaults to 30", () => {
    const s = useNarrationSync({ words: [] });
    expect(s.fps).toBe(30);
  });

  it("respects fps override", () => {
    const s = useNarrationSync({ words: [], fps: 24 });
    expect(s.fps).toBe(24);
  });
});
