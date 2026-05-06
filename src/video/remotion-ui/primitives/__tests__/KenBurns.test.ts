/**
 * KenBurns — scale values at frame 0 and last frame, pan, lofi disable.
 * Tests use renderToString (no JSX, node env).
 */

import { describe, it, expect, vi } from "vitest";

let mockFrame = 0;

vi.mock("remotion", () => ({
  useCurrentFrame: () => mockFrame,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 300 }),
  AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement("div", { style }, children),
  interpolate: (
    input: number,
    inRange: number[],
    outRange: number[],
    _opts?: unknown,
  ) => {
    // Linear interpolation
    const [i0, i1] = inRange;
    const [o0, o1] = outRange;
    const t = Math.max(0, Math.min(1, (input - i0) / (i1 - i0)));
    return o0 + t * (o1 - o0);
  },
}));

vi.mock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));
vi.mock("@/remotion-ui/themes/BrandProvider", () => ({
  usePalette: () => ({
    bg: "#002626", surface: "#003333", border: "#004d4d",
    accent: "#00807f", highlight: "#66cccc", textPri: "#f0f5f5", textSec: "#b3c4c4",
    lofi: false,
  }),
}));

import React from "react";
// @ts-ignore — @types/react-dom not installed; same pattern as KineticText.test.ts
import { renderToString } from "react-dom/server";
import { KenBurns } from "../KenBurns";

describe("KenBurns — scale interpolation", () => {
  it("at frame 0, scale equals `from` (default 1.08)", () => {
    mockFrame = 0;
    const html = renderToString(
      React.createElement(KenBurns, { from: 1.08, to: 1.0, duration: 6 },
        React.createElement("div", null, "child"),
      ),
    );
    expect(html).toContain("scale(1.08)");
  });

  it("at last frame (6s × 30fps = 180), scale equals `to` (default 1.0)", () => {
    mockFrame = 180;
    const html = renderToString(
      React.createElement(KenBurns, { from: 1.08, to: 1.0, duration: 6 },
        React.createElement("div", null, "child"),
      ),
    );
    expect(html).toContain("scale(1)");
  });

  it("custom from/to values are respected", () => {
    mockFrame = 0;
    const html = renderToString(
      React.createElement(KenBurns, { from: 1.2, to: 1.0, duration: 4 },
        React.createElement("div", null, "child"),
      ),
    );
    expect(html).toContain("scale(1.2)");
  });
});

describe("KenBurns — pan", () => {
  it("includes translate when pan provided", () => {
    mockFrame = 0;
    const html = renderToString(
      React.createElement(
        KenBurns,
        { from: 1.0, to: 1.0, duration: 6, pan: { fromX: 0.05, toX: -0.05 } },
        React.createElement("div", null, "child"),
      ),
    );
    expect(html).toContain("translate(");
  });
});

describe("KenBurns — lofi mode", () => {
  it("renders scale(1) with no animation in lofi mode", async () => {
    vi.resetModules();
    vi.doMock("remotion", () => ({
      useCurrentFrame: () => 0,
      useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 300 }),
      AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
        React.createElement("div", { style }, children),
      interpolate: (input: number, inRange: number[], outRange: number[]) => {
        const t = Math.max(0, Math.min(1, (input - inRange[0]) / (inRange[1] - inRange[0])));
        return outRange[0] + t * (outRange[1] - outRange[0]);
      },
    }));
    vi.doMock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));
    vi.doMock("@/remotion-ui/themes/BrandProvider", () => ({
      usePalette: () => ({
        bg: "#fafafa", surface: "#eee", border: "#ccc",
        accent: "#888", highlight: "#555", textPri: "#222", textSec: "#666",
        lofi: true,
      }),
    }));

    const { KenBurns: LofiKB } = await import("../KenBurns");
    const html = renderToString(
      React.createElement(LofiKB, { from: 1.08, to: 1.0, duration: 6 },
        React.createElement("div", null, "child"),
      ),
    );
    // In lofi mode, transform is always scale(1) — no animation
    expect(html).toContain("scale(1)");
    expect(html).not.toContain("scale(1.08)");
  });
});
