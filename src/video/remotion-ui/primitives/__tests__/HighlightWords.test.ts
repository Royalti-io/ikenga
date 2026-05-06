/**
 * HighlightWords — whitespace regression + phrase highlighting + lofi mode.
 * Uses renderToString via react-dom/server (no JSX, node env).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("remotion", () => ({}));
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
import { HighlightWords, splitSegments } from "../HighlightWords";

// ── splitSegments (pure function — no mocks needed) ────────────────────────

describe("splitSegments", () => {
  it("WHITESPACE REGRESSION: preserved around single highlighted word", () => {
    const segs = splitSegments("Run an audit on my catalog splits", ["audit"]);
    const joined = segs.map((s) => s.content).join("");
    expect(joined).toBe("Run an audit on my catalog splits");
  });

  it("contains space before and after matched word", () => {
    const segs = splitSegments("Run an audit on my catalog splits", ["audit"]);
    // The segment before "audit" ends with a space, or "audit" includes no extra glue
    const plain = segs.filter((s) => !s.highlight).map((s) => s.content).join("");
    // Plain segments contain " an " and " on my catalog splits"
    expect(plain).toContain(" an ");
  });

  it("matches multi-word phrases correctly", () => {
    const segs = splitSegments("Meet Ask Roy today", ["Ask Roy"]);
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.content);
    expect(highlighted).toContain("Ask Roy");
  });

  it("case-insensitive match, preserves original casing in output", () => {
    const segs = splitSegments("Meet Ask Roy today", ["ask roy"]);
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.content);
    // Original casing "Ask Roy" preserved in output
    expect(highlighted).toContain("Ask Roy");
  });

  it("returns full text intact when no words match", () => {
    const segs = splitSegments("Hello world", ["xyz"]);
    const joined = segs.map((s) => s.content).join("");
    expect(joined).toBe("Hello world");
  });

  it("returns full text intact when words array is empty", () => {
    const segs = splitSegments("Hello world", []);
    const joined = segs.map((s) => s.content).join("");
    expect(joined).toBe("Hello world");
  });

  it("longer phrase wins over single word in overlap", () => {
    const segs = splitSegments("Ask Roy is great", ["Roy", "Ask Roy"]);
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.content);
    expect(highlighted).toContain("Ask Roy");
    expect(highlighted).not.toContain("Roy");
  });
});

// ── HighlightWords rendered text ───────────────────────────────────────────

describe("HighlightWords rendered text", () => {
  function extractText(html: string): string {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  it("WHITESPACE REGRESSION: rendered text content equals input (spaces preserved)", () => {
    const input = "Run an audit on my catalog splits.";
    const html = renderToString(
      React.createElement(HighlightWords, {
        text: input,
        words: ["audit"],
      }),
    );
    const text = extractText(html);
    expect(text).toBe(input);
  });

  it("multi-word phrase highlighted without eating spaces", () => {
    const input = "Meet Ask Roy today.";
    const html = renderToString(
      React.createElement(HighlightWords, { text: input, words: ["Ask Roy"] }),
    );
    const text = extractText(html);
    expect(text).toBe(input);
  });

  it("accent color applied to highlighted word", () => {
    const html = renderToString(
      React.createElement(HighlightWords, {
        text: "Hello world",
        words: ["world"],
        accent: "#ff0000",
      }),
    );
    expect(html).toContain("#ff0000");
  });

  it("uses palette.highlight by default", () => {
    const html = renderToString(
      React.createElement(HighlightWords, { text: "Hello world", words: ["world"] }),
    );
    expect(html).toContain("#66cccc");
  });
});

// ── HighlightWords lofi mode ───────────────────────────────────────────────

describe("HighlightWords — lofi mode", () => {
  it("uses textPri color and underline instead of accent", async () => {
    vi.resetModules();
    vi.doMock("@/remotion-ui/themes/BrandProvider", () => ({
      usePalette: () => ({
        bg: "#fafafa", surface: "#eeeeee", border: "#cccccc",
        accent: "#888", highlight: "#555", textPri: "#222", textSec: "#666",
        lofi: true,
      }),
    }));
    vi.doMock("remotion", () => ({}));
    vi.doMock("@/config/fonts", () => ({ fontFamily: "Plus Jakarta Sans" }));

    const { HighlightWords: LofiHW } = await import("../HighlightWords");
    const html = renderToString(
      React.createElement(LofiHW, { text: "Hello world", words: ["world"] }),
    );
    // Should NOT use accent/highlight color
    expect(html).not.toContain("#555");
    // Should use textPri
    expect(html).toContain("#222");
    // Should underline
    expect(html).toContain("underline");
  });
});
