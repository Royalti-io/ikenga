import { describe, it, expect } from "vitest";
import { processNarrationText, estimateDuration } from "./script-text";

// ── processNarrationText ──────────────────────────────────────────────────

describe("processNarrationText", () => {
  it("returns clean text and no markers for plain text", () => {
    const result = processNarrationText("Hello world");
    expect(result.text).toBe("Hello world");
    expect(result.markers).toEqual([]);
  });

  it("extracts [BEAT] markers", () => {
    const result = processNarrationText("Hello [BEAT] world");
    expect(result.text).toBe("Hello world");
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].type).toBe("beat");
  });

  it("extracts [PAUSE] markers", () => {
    const result = processNarrationText("Hello [PAUSE] world");
    expect(result.text).toBe("Hello world");
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].type).toBe("pause");
  });

  it("handles multiple markers", () => {
    const result = processNarrationText("One [BEAT] two [PAUSE] three [BEAT] four");
    expect(result.text).toBe("One two three four");
    expect(result.markers).toHaveLength(3);
    expect(result.markers.map((m) => m.type)).toEqual(["beat", "pause", "beat"]);
  });

  it("is case-insensitive for markers", () => {
    const result = processNarrationText("Hello [beat] world [Pause] end");
    expect(result.markers).toHaveLength(2);
  });

  it("strips HTML visual comments", () => {
    const result = processNarrationText("Hello <!-- VISUAL: diagram --> world");
    expect(result.text).toBe("Hello world");
  });

  it("adds marker duration to estimated time", () => {
    const plain = processNarrationText("Hello world");
    const withBeat = processNarrationText("Hello [BEAT] world");
    const withPause = processNarrationText("Hello [PAUSE] world");

    // Same word count, but with added marker time
    expect(withBeat.estimatedDurationSec).toBeCloseTo(plain.estimatedDurationSec + 0.5);
    expect(withPause.estimatedDurationSec).toBeCloseTo(plain.estimatedDurationSec + 1.0);
  });

  it("handles empty string", () => {
    const result = processNarrationText("");
    expect(result.text).toBe("");
    expect(result.markers).toEqual([]);
    expect(result.estimatedDurationSec).toBe(0);
  });
});

// ── estimateDuration ──────────────────────────────────────────────────────

describe("estimateDuration", () => {
  it("estimates based on WPM", () => {
    // 150 words at 150 WPM = 60 seconds
    const words = Array(150).fill("word").join(" ");
    expect(estimateDuration(words)).toBeCloseTo(60);
  });

  it("returns 0 for empty text", () => {
    expect(estimateDuration("")).toBe(0);
  });

  it("does NOT count [BEAT] markers as words (bug fix)", () => {
    const withoutMarker = estimateDuration("Hello world");
    const withMarker = estimateDuration("Hello [BEAT] world");

    // With marker should have same word-based duration PLUS 0.5s for the beat
    // NOT a higher word count
    expect(withMarker).toBeCloseTo(withoutMarker + 0.5);
  });

  it("does NOT count [PAUSE] markers as words (bug fix)", () => {
    const withoutMarker = estimateDuration("Hello world");
    const withMarker = estimateDuration("Hello [PAUSE] world");

    expect(withMarker).toBeCloseTo(withoutMarker + 1.0);
  });

  it("adds pause time for markers (bug fix)", () => {
    const base = estimateDuration("one two three four five");
    const withBeats = estimateDuration("one [BEAT] two [BEAT] three four five");
    const withPause = estimateDuration("one [PAUSE] two three four five");

    expect(withBeats).toBeCloseTo(base + 1.0); // 2 beats * 0.5s
    expect(withPause).toBeCloseTo(base + 1.0); // 1 pause * 1.0s
  });
});
