import { describe, it, expect } from "vitest";
import {
  secondsToFrames,
  framesToSeconds,
  buildVoiceoverTimeline,
  isVoiceActiveAtFrame,
  calculateTotalDuration,
  type VoiceoverManifest,
} from "./audio-timeline";

// ── Helper ─────────────────────────────────────────────────────────────────

function makeManifest(sections: Array<{ id: string; durationSec: number }>): VoiceoverManifest {
  return {
    slug: "test",
    generatedAt: "2026-01-01",
    voiceId: "v1",
    model: "m1",
    sections: sections.map((s) => ({
      id: s.id,
      title: s.id,
      file: `audio/${s.id}.mp3`,
      text: "test",
      durationSec: s.durationSec,
    })),
    totalDurationSec: sections.reduce((sum, s) => sum + s.durationSec, 0),
  };
}

// ── secondsToFrames / framesToSeconds ──────────────────────────────────────

describe("secondsToFrames", () => {
  it("converts 1 second at 30fps", () => {
    expect(secondsToFrames(1, 30)).toBe(30);
  });

  it("converts 0 seconds", () => {
    expect(secondsToFrames(0, 30)).toBe(0);
  });

  it("rounds fractional frames", () => {
    // 0.5s at 30fps = 15 frames exactly
    expect(secondsToFrames(0.5, 30)).toBe(15);
    // 0.1s at 30fps = 3 frames (Math.round)
    expect(secondsToFrames(0.1, 30)).toBe(3);
  });

  it("handles high fps", () => {
    expect(secondsToFrames(1, 60)).toBe(60);
  });
});

describe("framesToSeconds", () => {
  it("converts 30 frames at 30fps to 1 second", () => {
    expect(framesToSeconds(30, 30)).toBe(1);
  });

  it("converts 0 frames", () => {
    expect(framesToSeconds(0, 30)).toBe(0);
  });

  it("returns fractional seconds", () => {
    expect(framesToSeconds(15, 30)).toBe(0.5);
  });
});

// ── buildVoiceoverTimeline ────────────────────────────────────────────────

describe("buildVoiceoverTimeline", () => {
  it("returns empty array for empty manifest", () => {
    const manifest = makeManifest([]);
    expect(buildVoiceoverTimeline(manifest, 30)).toEqual([]);
  });

  it("builds single-section timeline", () => {
    const manifest = makeManifest([{ id: "hook", durationSec: 2 }]);
    const timeline = buildVoiceoverTimeline(manifest, 30);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toEqual({
      sectionId: "hook",
      startFrame: 0,
      endFrame: 60,
      file: "audio/hook.mp3",
      durationSec: 2,
    });
  });

  it("builds multi-section timeline with default 15-frame gap", () => {
    const manifest = makeManifest([
      { id: "hook", durationSec: 2 },
      { id: "s1", durationSec: 3 },
      { id: "cta", durationSec: 1 },
    ]);
    const timeline = buildVoiceoverTimeline(manifest, 30);

    expect(timeline).toHaveLength(3);

    // hook: 0-60
    expect(timeline[0].startFrame).toBe(0);
    expect(timeline[0].endFrame).toBe(60);

    // s1: 60 + 15 gap = 75, duration 90 frames, ends at 165
    expect(timeline[1].startFrame).toBe(75);
    expect(timeline[1].endFrame).toBe(165);

    // cta: 165 + 15 gap = 180, duration 30 frames, ends at 210
    expect(timeline[2].startFrame).toBe(180);
    expect(timeline[2].endFrame).toBe(210);
  });

  it("respects custom gap", () => {
    const manifest = makeManifest([
      { id: "a", durationSec: 1 },
      { id: "b", durationSec: 1 },
    ]);
    const timeline = buildVoiceoverTimeline(manifest, 30, 0);

    // No gap: a ends at 30, b starts at 30
    expect(timeline[1].startFrame).toBe(30);
  });
});

// ── isVoiceActiveAtFrame ──────────────────────────────────────────────────

describe("isVoiceActiveAtFrame", () => {
  const manifest = makeManifest([
    { id: "a", durationSec: 2 },
    { id: "b", durationSec: 1 },
  ]);
  const timeline = buildVoiceoverTimeline(manifest, 30);
  // a: 0-60, b: 75-105

  it("returns true at start of section", () => {
    expect(isVoiceActiveAtFrame(0, timeline)).toBe(true);
  });

  it("returns true inside section", () => {
    expect(isVoiceActiveAtFrame(30, timeline)).toBe(true);
  });

  it("returns false at exact end of section (exclusive)", () => {
    expect(isVoiceActiveAtFrame(60, timeline)).toBe(false);
  });

  it("returns false in gap between sections", () => {
    expect(isVoiceActiveAtFrame(65, timeline)).toBe(false);
  });

  it("returns true at start of second section", () => {
    expect(isVoiceActiveAtFrame(75, timeline)).toBe(true);
  });

  it("returns false before any section", () => {
    expect(isVoiceActiveAtFrame(-1, timeline)).toBe(false);
  });

  it("returns false after all sections", () => {
    expect(isVoiceActiveAtFrame(200, timeline)).toBe(false);
  });

  it("returns false for empty timeline", () => {
    expect(isVoiceActiveAtFrame(0, [])).toBe(false);
  });
});

// ── calculateTotalDuration ────────────────────────────────────────────────

describe("calculateTotalDuration", () => {
  it("returns padding only for empty manifest", () => {
    const manifest = makeManifest([]);
    expect(calculateTotalDuration(manifest, 30)).toBe(90);
  });

  it("returns last endFrame + padding for single section", () => {
    const manifest = makeManifest([{ id: "hook", durationSec: 2 }]);
    // endFrame = 60, padding = 90
    expect(calculateTotalDuration(manifest, 30)).toBe(150);
  });

  it("respects custom padding", () => {
    const manifest = makeManifest([{ id: "hook", durationSec: 1 }]);
    expect(calculateTotalDuration(manifest, 30, 0)).toBe(30);
  });
});
