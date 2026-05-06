/**
 * Stat — render tests via react-dom/server (no JSX, node env).
 */

import { describe, it, expect, vi } from "vitest";

// Remotion mocks — must be hoisted before import
vi.mock("remotion", () => ({
  useCurrentFrame: () => 60,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 300 }),
  spring: (_opts: unknown) => 1,
  interpolate: (_input: number, _inRange: number[], outRange: number[]) =>
    outRange[outRange.length - 1],
}));

vi.mock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));

vi.mock("@/remotion-ui/themes/BrandProvider", () => ({
  usePalette: () => ({
    bg: "#002626",
    surface: "#003333",
    border: "#004d4d",
    accent: "#00807f",
    highlight: "#66cccc",
    textPri: "#f0f5f5",
    textSec: "#b3c4c4",
    lofi: false,
  }),
}));

import React from "react";
// @ts-ignore — @types/react-dom not installed; same pattern as KineticText.test.ts
import { renderToString } from "react-dom/server";
import { Stat } from "../Stat";

describe("Stat", () => {
  it("renders value and label", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "20 min", label: "to find one number" }),
    );
    expect(html).toContain("20 min");
    expect(html).toContain("to find one number");
  });

  it("renders subline above value when provided", () => {
    const html = renderToString(
      React.createElement(Stat, {
        value: "126",
        label: "tools",
        subline: "built-in",
      }),
    );
    expect(html).toContain("built-in");
    expect(html).toContain("126");
    expect(html).toContain("tools");
  });

  it("uses palette.highlight as default color", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items" }),
    );
    expect(html).toContain("#66cccc");
  });

  it("uses accent override when provided", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items", accent: "#ff0000" }),
    );
    expect(html).toContain("#ff0000");
  });

  it("applies text-shadow in hifi mode", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items" }),
    );
    expect(html).toContain("text-shadow");
    expect(html).not.toContain("text-shadow:none");
  });

  it("uses sm fontSize 48", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items", size: "sm" }),
    );
    expect(html).toContain("48px");
  });

  it("uses md fontSize 72", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items", size: "md" }),
    );
    expect(html).toContain("72px");
  });

  it("uses lg fontSize 96", () => {
    const html = renderToString(
      React.createElement(Stat, { value: "42", label: "items", size: "lg" }),
    );
    expect(html).toContain("96px");
  });
});

describe("Stat — lofi mode", () => {
  it("strips text-shadow in lofi mode", async () => {
    vi.resetModules();
    vi.doMock("@/remotion-ui/themes/BrandProvider", () => ({
      usePalette: () => ({
        bg: "#fafafa", surface: "#eeeeee", border: "#cccccc",
        accent: "#888", highlight: "#555", textPri: "#222", textSec: "#666",
        lofi: true,
      }),
    }));
    vi.doMock("remotion", () => ({
      useCurrentFrame: () => 0,
      useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 300 }),
      spring: () => 1,
      interpolate: (_input: number, _inRange: number[], outRange: number[]) =>
        outRange[outRange.length - 1],
    }));
    vi.doMock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));

    const { Stat: LofiStat } = await import("../Stat");
    const html = renderToString(
      React.createElement(LofiStat, { value: "42", label: "items" }),
    );
    // In lofi, textShadow is "none"
    expect(html).toContain("none");
    expect(html).not.toMatch(/text-shadow:[^n]/);
  });
});
