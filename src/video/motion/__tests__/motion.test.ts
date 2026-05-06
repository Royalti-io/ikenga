/**
 * Motion vocabulary tests.
 *
 * Three categories:
 *   1. Entrance helpers (settle, snap, bloom) — boundary conditions + snapshots.
 *   2. lag / lead — offset math at 30fps and 60fps.
 *   3. applyOffset — combined offset + clamping.
 *
 * Snapshot tests lock down the spring feel so any future tuning is caught
 * loudly. If you intentionally change a spring config, update the snapshots.
 */

import { describe, it, expect } from "vitest";
import { settle, snap, bloom, lag, lead, applyOffset } from "../index";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FPS = 30;

// ── settle ────────────────────────────────────────────────────────────────────

describe("settle", () => {
  it("returns 0 at startAt frame", () => {
    expect(settle({ frame: 12, fps: FPS, startAt: 12 })).toBe(0);
  });

  it("returns ~1 at startAt + 30 (fully settled)", () => {
    const value = settle({ frame: 42, fps: FPS, startAt: 12 });
    // Springs can very slightly exceed 1 even with heavy configs — just check
    // that it's within a rounding tolerance of 1.
    expect(value).toBeGreaterThan(0.95);
    expect(value).toBeCloseTo(1, 3);
  });

  it("returns 0 for frames before startAt (clamped left)", () => {
    expect(settle({ frame: 11, fps: FPS, startAt: 12 })).toBe(0);
    expect(settle({ frame: 0, fps: FPS, startAt: 12 })).toBe(0);
  });

  it("defaults startAt to 0", () => {
    expect(settle({ frame: 0, fps: FPS })).toBe(0);
    const value = settle({ frame: 30, fps: FPS });
    expect(value).toBeGreaterThan(0.95);
  });

  // Regression snapshot: lock down exact outputs at key frames
  it("snapshot: settle outputs at frames 0,5,10,15,20 (startAt=0)", () => {
    const frames = [0, 5, 10, 15, 20];
    const outputs = frames.map((f) => settle({ frame: f, fps: FPS, startAt: 0 }));
    // Values must be strictly increasing (spring progresses forward)
    for (let i = 1; i < outputs.length; i++) {
      expect(outputs[i]).toBeGreaterThan(outputs[i - 1]);
    }
    // Snapshot the actual values for regression detection
    expect(outputs).toMatchSnapshot();
  });
});

// ── snap ──────────────────────────────────────────────────────────────────────

describe("snap", () => {
  it("returns 0 at startAt frame", () => {
    expect(snap({ frame: 5, fps: FPS, startAt: 5 })).toBe(0);
  });

  it("returns ~1 at startAt + 30 (fully settled)", () => {
    const value = snap({ frame: 35, fps: FPS, startAt: 5 });
    expect(value).toBeGreaterThan(0.95);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("returns 0 for frames before startAt", () => {
    expect(snap({ frame: 4, fps: FPS, startAt: 5 })).toBe(0);
  });

  it("settles faster than settle (lighter spring)", () => {
    // snap uses a lighter config — should reach 0.9 sooner than settle
    const snapAt15 = snap({ frame: 15, fps: FPS, startAt: 0 });
    const settleAt15 = settle({ frame: 15, fps: FPS, startAt: 0 });
    expect(snapAt15).toBeGreaterThanOrEqual(settleAt15);
  });

  // Regression snapshot
  it("snapshot: snap outputs at frames 0,5,10,15,20 (startAt=0)", () => {
    const frames = [0, 5, 10, 15, 20];
    const outputs = frames.map((f) => snap({ frame: f, fps: FPS, startAt: 0 }));
    expect(outputs).toMatchSnapshot();
  });
});

// ── bloom ─────────────────────────────────────────────────────────────────────

describe("bloom", () => {
  it("returns 0 at startAt frame", () => {
    expect(bloom({ frame: 8, fps: FPS, startAt: 8 })).toBe(0);
  });

  it("returns ~1 at startAt + 30", () => {
    const value = bloom({ frame: 38, fps: FPS, startAt: 8 });
    // bouncy can exceed 1 due to overshoot, but should be close to 1 by +30
    expect(value).toBeGreaterThan(0.85);
  });

  it("returns 0 for frames before startAt", () => {
    expect(bloom({ frame: 7, fps: FPS, startAt: 8 })).toBe(0);
  });

  it("can exceed 1 (overshoot) during animation", () => {
    // The bouncy config should produce overshoot somewhere in 5–15 frames
    const values = Array.from({ length: 30 }, (_, i) =>
      bloom({ frame: i, fps: FPS, startAt: 0 }),
    );
    const hasOvershoot = values.some((v) => v > 1.0);
    expect(hasOvershoot).toBe(true);
  });

  // Regression snapshot
  it("snapshot: bloom outputs at frames 0,5,10,15,20 (startAt=0)", () => {
    const frames = [0, 5, 10, 15, 20];
    const outputs = frames.map((f) => bloom({ frame: f, fps: FPS, startAt: 0 }));
    expect(outputs).toMatchSnapshot();
  });
});

// ── lag ───────────────────────────────────────────────────────────────────────

describe("lag", () => {
  it("200ms at 30fps = 6 frames", () => {
    expect(lag(200).offsetFrames(30)).toBe(6);
  });

  it("200ms at 60fps = 12 frames", () => {
    expect(lag(200).offsetFrames(60)).toBe(12);
  });

  it("100ms at 30fps = 3 frames", () => {
    expect(lag(100).offsetFrames(30)).toBe(3);
  });

  it("0ms = 0 frames", () => {
    expect(lag(0).offsetFrames(30)).toBe(0);
  });

  it("exposes the ms value", () => {
    expect(lag(150).ms).toBe(150);
  });

  it("rounds fractional frame counts", () => {
    // 50ms at 30fps = 1.5 frames → rounds to 2
    expect(lag(50).offsetFrames(30)).toBe(2);
  });
});

// ── lead ──────────────────────────────────────────────────────────────────────

describe("lead", () => {
  it("200ms at 30fps = -6 frames", () => {
    expect(lead(200).offsetFrames(30)).toBe(-6);
  });

  it("200ms at 60fps = -12 frames", () => {
    expect(lead(200).offsetFrames(60)).toBe(-12);
  });

  it("stores negative ms", () => {
    expect(lead(150).ms).toBe(-150);
  });

  it("0ms = 0 frames", () => {
    expect(lead(0).offsetFrames(30)).toBe(0);
  });
});

// ── applyOffset ───────────────────────────────────────────────────────────────

describe("applyOffset", () => {
  it("lag(200) at 30fps adds 6 frames", () => {
    expect(applyOffset(40, lag(200), 30)).toBe(46);
  });

  it("lead(200) at 30fps subtracts 6 frames", () => {
    expect(applyOffset(40, lead(200), 30)).toBe(34);
  });

  it("clamps to 0 when lead exceeds frame", () => {
    // frame=5, lead=300ms at 30fps → 5 - 9 = -4 → clamped to 0
    expect(applyOffset(5, lead(300), 30)).toBe(0);
  });

  it("lag with frame=0 adds offset normally", () => {
    expect(applyOffset(0, lag(200), 30)).toBe(6);
  });

  it("zero offset returns original frame", () => {
    expect(applyOffset(20, lag(0), 30)).toBe(20);
    expect(applyOffset(20, lead(0), 30)).toBe(20);
  });
});
