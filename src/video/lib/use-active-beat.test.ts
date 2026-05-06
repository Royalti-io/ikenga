/**
 * Tests for resolveActiveBeat (the pure helper underlying useActiveBeat).
 *
 * The React hook itself depends on useCurrentFrame() and useStoryboard()
 * which require a Remotion composition context — those paths are exercised
 * in integration via Remotion Studio preview. Unit tests cover the pure
 * resolver which contains all of the logic.
 */

import { describe, it, expect } from "vitest";
import { resolveActiveBeat } from "./use-active-beat";
import { defineBeats } from "./define-beats";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const beats = defineBeats(
  [
    { id: "hook",    label: "Hook",    time: { start: 0,    end: 3.8  } },
    { id: "problem", label: "Problem", time: { start: 3.8,  end: 15.3 } },
    { id: "cta",     label: "CTA",     time: { start: 15.3, end: 20.0 } },
  ],
  { fps: 30 },
);

// After defineBeats at 30fps:
//   hook:    frames [0,   114)   (floor(0 * 30)=0,    floor(3.8 * 30)=114)
//   problem: frames [114, 459)   (floor(3.8 * 30)=114, floor(15.3 * 30)=459)
//   cta:     frames [459, 600)   (floor(15.3 * 30)=459, floor(20.0 * 30)=600)

// ── resolveActiveBeat ─────────────────────────────────────────────────────────

describe("resolveActiveBeat — with defineBeats fixtures", () => {
  it("frame 0 is in the hook beat with frameInBeat=0", () => {
    const result = resolveActiveBeat(0, beats);
    expect(result.beat?.id).toBe("hook");
    expect(result.frameInBeat).toBe(0);
    expect(result.index).toBe(0);
  });

  it("mid-beat frame resolves correctly", () => {
    const result = resolveActiveBeat(50, beats);
    expect(result.beat?.id).toBe("hook");
    expect(result.frameInBeat).toBe(50);
    expect(result.index).toBe(0);
  });

  it("exact start of beat → inside that beat, frameInBeat=0", () => {
    // hook.frames.start = 0 → handled above
    // problem.frames.start = 114
    const result = resolveActiveBeat(114, beats);
    expect(result.beat?.id).toBe("problem");
    expect(result.frameInBeat).toBe(0);
    expect(result.index).toBe(1);
  });

  it("exact end of beat → belongs to NEXT beat (end is exclusive)", () => {
    // hook.frames.end = 114 → frame 114 should be in 'problem', not 'hook'
    const result = resolveActiveBeat(114, beats);
    expect(result.beat?.id).toBe("problem");
  });

  it("last frame inside problem beat", () => {
    // problem ends at 459, so frame 458 is the last frame inside
    const result = resolveActiveBeat(458, beats);
    expect(result.beat?.id).toBe("problem");
    expect(result.frameInBeat).toBe(458 - 114);
  });

  it("first frame of cta beat", () => {
    const result = resolveActiveBeat(459, beats);
    expect(result.beat?.id).toBe("cta");
    expect(result.frameInBeat).toBe(0);
    expect(result.index).toBe(2);
  });

  it("frame past last beat returns null", () => {
    // cta ends at frame 600
    const result = resolveActiveBeat(600, beats);
    expect(result.beat).toBeNull();
    expect(result.frameInBeat).toBe(0);
    expect(result.index).toBe(-1);
  });

  it("frame well past all beats returns null", () => {
    const result = resolveActiveBeat(9999, beats);
    expect(result.beat).toBeNull();
    expect(result.index).toBe(-1);
  });
});

describe("resolveActiveBeat — with explicit frame ranges", () => {
  // Tests with manually-specified frames (no defineBeats)
  const manualBeats = [
    { id: "a", label: "A", time: { start: 0, end: 1 }, frames: { start: 0, end: 10 } },
    { id: "b", label: "B", time: { start: 1, end: 2 }, frames: { start: 10, end: 20 } },
    { id: "c", label: "C", time: { start: 2, end: 3 }, frames: { start: 20, end: 30 } },
  ];

  it("resolves beat 'a' at frame 0", () => {
    expect(resolveActiveBeat(0, manualBeats).beat?.id).toBe("a");
  });

  it("resolves beat 'b' at frame 10 (exact start)", () => {
    const result = resolveActiveBeat(10, manualBeats);
    expect(result.beat?.id).toBe("b");
    expect(result.frameInBeat).toBe(0);
  });

  it("resolves beat 'c' at frame 25", () => {
    const result = resolveActiveBeat(25, manualBeats);
    expect(result.beat?.id).toBe("c");
    expect(result.frameInBeat).toBe(5);
  });

  it("frame at end of 'a' (10) → 'b'", () => {
    expect(resolveActiveBeat(10, manualBeats).beat?.id).toBe("b");
  });

  it("frame 30 (past last beat) → null", () => {
    expect(resolveActiveBeat(30, manualBeats).beat).toBeNull();
  });
});

describe("resolveActiveBeat — empty beats array", () => {
  it("returns null result for empty beats", () => {
    const result = resolveActiveBeat(0, []);
    expect(result.beat).toBeNull();
    expect(result.frameInBeat).toBe(0);
    expect(result.index).toBe(-1);
  });
});

describe("resolveActiveBeat — beats without frames (time fallback)", () => {
  // defineBeats fills frames, but the type allows omitting them
  const timeFallbackBeats = [
    { id: "x", label: "X", time: { start: 0, end: 1 } },   // → [0, 30) at 30fps
    { id: "y", label: "Y", time: { start: 1, end: 2 } },   // → [30, 60)
  ];

  it("falls back to time × 30fps when frames absent", () => {
    const result = resolveActiveBeat(15, timeFallbackBeats);
    expect(result.beat?.id).toBe("x");
    expect(result.frameInBeat).toBe(15);
  });

  it("boundary: frame 30 → 'y'", () => {
    expect(resolveActiveBeat(30, timeFallbackBeats).beat?.id).toBe("y");
  });
});
