/**
 * RevealList — stagger timing, per-item overrides, narration word sync, directions.
 * Tests are pure logic (no JSX) using renderToString for HTML assertions.
 */

import { describe, it, expect, vi } from "vitest";

let mockFrame = 0;
const mockFps = 30;

vi.mock("remotion", () => ({
  useCurrentFrame: () => mockFrame,
  useVideoConfig: () => ({ fps: mockFps, width: 1080, height: 1920, durationInFrames: 300 }),
  spring: (opts: { frame: number; fps: number; from?: number; to?: number }) => {
    // Returns 0 when frame <= 0, 1 when frame > 0 (step function for test clarity)
    return opts.frame <= 0 ? 0 : 1;
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

vi.mock("@/remotion-ui/themes/StoryboardProvider", () => ({
  useStoryboard: () => ({ slug: "", beats: [], narration: undefined }),
}));

vi.mock("@/lib/use-narration-sync", () => ({
  useNarrationSync: () => ({
    frameForWord: () => null,
    frameForSecond: (s: number) => Math.floor(s * 30),
    fps: 30,
  }),
}));

import React from "react";
// @ts-ignore — @types/react-dom not installed; same pattern as KineticText.test.ts
import { renderToString } from "react-dom/server";
import { RevealList } from "../RevealList";

describe("RevealList — stagger timing", () => {
  it("renders all items", () => {
    mockFrame = 999;
    const html = renderToString(
      React.createElement(RevealList, {
        items: [
          { content: "Item A" },
          { content: "Item B" },
          { content: "Item C" },
        ],
        stagger: 24,
        startAt: 0,
      }),
    );
    expect(html).toContain("Item A");
    expect(html).toContain("Item B");
    expect(html).toContain("Item C");
  });

  it("item at frame < reveal frame is invisible (spring returns 0)", () => {
    // frame=0, item 2 should reveal at stagger=24 → relative frame = -24 → spring=0
    mockFrame = 0;
    const html = renderToString(
      React.createElement(RevealList, {
        items: [{ content: "First" }, { content: "Second" }],
        stagger: 24,
        startAt: 0,
      }),
    );
    // "First" at revealFrame=0 → spring(frame=0 - 0 = 0) → 0 → opacity 0
    // We can verify opacity:0 appears in the output
    expect(html).toContain("opacity:0");
  });

  it("per-item revealAtFrame overrides stagger", () => {
    mockFrame = 100;
    // With custom frame, item should be revealed (spring > 0)
    const html = renderToString(
      React.createElement(RevealList, {
        items: [{ content: "Custom", revealAtFrame: 50 }],
        stagger: 24,
        startAt: 0,
      }),
    );
    // frame=100, revealFrame = startAt(0) + revealAtFrame(50) = 50 → spring(50) = 1
    expect(html).toContain("opacity:1");
  });
});

describe("RevealList — horizontal direction", () => {
  it("renders flex-direction row", () => {
    mockFrame = 999;
    const html = renderToString(
      React.createElement(RevealList, {
        items: [{ content: "A" }, { content: "B" }],
        direction: "horizontal",
      }),
    );
    expect(html).toContain("flex-direction:row");
  });
});

describe("RevealList — per-item revealAtFrame vs revealAtWord", () => {
  it("revealAtWord takes precedence (mocked to return null — falls back to revealAtFrame)", () => {
    // useNarrationSync.frameForWord returns null in our mock
    // So revealAtWord sync fails → falls back to revealAtFrame=10
    mockFrame = 20;
    const html = renderToString(
      React.createElement(RevealList, {
        items: [{ content: "Word-synced", revealAtFrame: 10, revealAtWord: "something" }],
        startAt: 0,
      }),
    );
    // Frame 20, revealFrame = 0+10 = 10 → spring(10) = 1
    expect(html).toContain("opacity:1");
  });
});

describe("RevealList — lofi mode", () => {
  it("renders 4px border-radius in lofi mode", async () => {
    vi.resetModules();
    vi.doMock("remotion", () => ({
      useCurrentFrame: () => 999,
      useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 300 }),
      spring: () => 1,
    }));
    vi.doMock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));
    vi.doMock("@/remotion-ui/themes/BrandProvider", () => ({
      usePalette: () => ({
        bg: "#fafafa", surface: "#eee", border: "#ccc",
        accent: "#888", highlight: "#555", textPri: "#222", textSec: "#666",
        lofi: true,
      }),
    }));
    vi.doMock("@/remotion-ui/themes/StoryboardProvider", () => ({
      useStoryboard: () => ({ slug: "", beats: [] }),
    }));
    vi.doMock("@/lib/use-narration-sync", () => ({
      useNarrationSync: () => ({ frameForWord: () => null, frameForSecond: () => 0, fps: 30 }),
    }));

    const { RevealList: LofiRL } = await import("../RevealList");
    const html = renderToString(
      React.createElement(LofiRL, {
        items: [{ content: "Hello" }],
      }),
    );
    expect(html).toContain("border-radius:4px");
  });
});
