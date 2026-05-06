/**
 * Tests for defineBeats() — validation, sort checking, overlap detection,
 * and auto-computed frames.
 */

import { describe, it, expect } from "vitest";
import { defineBeats, type Beat } from "./define-beats";

// ── Helpers ────────────────────────────────────────────────────────────────

function beat(
  id: string,
  start: number,
  end: number,
  frames?: Beat["frames"],
): Beat {
  return { id, label: id, time: { start, end }, frames };
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe("defineBeats — happy path", () => {
  it("returns beats with auto-computed frames at 30fps", () => {
    const result = defineBeats([beat("a", 0, 3.8), beat("b", 3.8, 15.3)]);

    expect(result[0].frames).toEqual({ start: 0, end: 114 });
    expect(result[1].frames).toEqual({ start: 114, end: 459 });
  });

  it("respects custom fps", () => {
    const result = defineBeats([beat("a", 0, 1)], { fps: 60 });
    expect(result[0].frames).toEqual({ start: 0, end: 60 });
  });

  it("floors fractional frame values", () => {
    const result = defineBeats([beat("a", 0, 1.0 / 3)], { fps: 30 });
    // 1/3 * 30 = 10.0 exactly — but let's use a real fractional case
    const result2 = defineBeats([beat("a", 0, 0.1)], { fps: 30 });
    // 0.1 * 30 = 3.0
    expect(result2[0].frames!.end).toBe(3);
    void result;
  });

  it("preserves explicit frames if already set", () => {
    const explicit = { start: 0, end: 99 };
    const result = defineBeats([beat("a", 0, 3, explicit)]);
    expect(result[0].frames).toEqual(explicit);
  });

  it("preserves optional beat fields", () => {
    const result = defineBeats([
      {
        id: "a",
        label: "A",
        time: { start: 0, end: 1 },
        narration_excerpt: "hello",
        intent: "test",
      },
    ]);
    expect(result[0].narration_excerpt).toBe("hello");
    expect(result[0].intent).toBe("test");
  });

  it("accepts a single beat", () => {
    const result = defineBeats([beat("only", 0, 5)]);
    expect(result).toHaveLength(1);
  });

  it("accepts an empty array", () => {
    const result = defineBeats([]);
    expect(result).toEqual([]);
  });

  it("allows adjacent beats (end === start is fine)", () => {
    expect(() =>
      defineBeats([beat("a", 0, 2), beat("b", 2, 4)]),
    ).not.toThrow();
  });
});

// ── Validation errors ──────────────────────────────────────────────────────

describe("defineBeats — validation", () => {
  it("throws if time.start < 0", () => {
    expect(() => defineBeats([beat("a", -1, 1)])).toThrow(/time\.start/);
  });

  it("throws if time.end <= time.start", () => {
    expect(() => defineBeats([beat("a", 2, 2)])).toThrow(/time\.end/);
    expect(() => defineBeats([beat("a", 5, 3)])).toThrow(/time\.end/);
  });

  it("throws if beats are not sorted (unsorted pair)", () => {
    expect(() =>
      defineBeats([beat("b", 5, 10), beat("a", 0, 4)]),
    ).toThrow(/not sorted/);
  });

  it("throws on overlapping beats", () => {
    expect(() =>
      defineBeats([beat("a", 0, 5), beat("b", 3, 8)]),
    ).toThrow(/overlap/);
  });

  it("overlap error names the two conflicting beats", () => {
    expect(() =>
      defineBeats([beat("alpha", 0, 5), beat("beta", 2, 7)]),
    ).toThrow(/alpha.*beta|beta.*alpha/);
  });
});
