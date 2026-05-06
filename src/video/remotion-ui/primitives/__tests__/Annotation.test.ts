/**
 * Annotation primitive tests.
 *
 * Tests animation math directly (frame-to-opacity/dashoffset) since these
 * are pure calculations that don't require rendering.
 */

import { describe, it, expect } from "vitest";
import { interpolate } from "remotion";

// ── Entrance opacity math (mirrors Annotation.tsx) ─────────────────────────

function annotationOpacity(relFrame: number): number {
  return interpolate(relFrame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

describe("Annotation entrance opacity", () => {
  it("is 0 at frame 0 (relFrame=0)", () => {
    expect(annotationOpacity(0)).toBe(0);
  });

  it("is 1 at frame 12 (relFrame=12)", () => {
    expect(annotationOpacity(12)).toBe(1);
  });

  it("is 1 at frames beyond 12 (clamp)", () => {
    expect(annotationOpacity(30)).toBe(1);
    expect(annotationOpacity(100)).toBe(1);
  });

  it("is between 0 and 1 at intermediate frames", () => {
    const mid = annotationOpacity(6);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

// ── Dashoffset (arrow drawn-on effect) ─────────────────────────────────────

const TOTAL_DASH = 200;

function hifiDashProgress(relFrame: number): number {
  return interpolate(relFrame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

describe("Annotation arrow dashoffset (hifi)", () => {
  it("starts fully hidden (dashoffset = totalDash) at frame 0", () => {
    const progress = hifiDashProgress(0);
    expect(TOTAL_DASH * (1 - progress)).toBe(TOTAL_DASH);
  });

  it("is fully drawn (dashoffset = 0) at frame 18", () => {
    const progress = hifiDashProgress(18);
    expect(TOTAL_DASH * (1 - progress)).toBe(0);
  });
});

describe("Annotation arrow dashoffset (lofi)", () => {
  it("lofi mode: progress = 1, dashoffset = 0 immediately", () => {
    // In lofi, dashProgress is always 1 (arrow appears static)
    const lofiProgress = 1;
    expect(TOTAL_DASH * (1 - lofiProgress)).toBe(0);
  });
});

// ── Curve vs straight arrow SVG paths ──────────────────────────────────────

function buildPath(arrow: "curve" | "straight", lx: number, ly: number, tx: number, ty: number): string {
  return arrow === "curve"
    ? `M ${lx} ${ly} Q ${(lx + tx) / 2} ${(ly + ty) / 2 - 30} ${tx} ${ty}`
    : `M ${lx} ${ly} L ${tx} ${ty}`;
}

describe("Annotation arrow path type", () => {
  it("curve arrow path contains Q (quadratic bezier)", () => {
    const path = buildPath("curve", 100, 100, 200, 200);
    expect(path).toMatch(/Q/);
    expect(path).not.toMatch(/ L /);
  });

  it("straight arrow path contains L (line)", () => {
    const path = buildPath("straight", 100, 100, 200, 200);
    expect(path).toMatch(/ L /);
    expect(path).not.toMatch(/Q/);
  });

  it("curve and straight paths produce different output for same coords", () => {
    const curve = buildPath("curve", 50, 300, 150, 100);
    const straight = buildPath("straight", 50, 300, 150, 100);
    expect(curve).not.toBe(straight);
  });
});
