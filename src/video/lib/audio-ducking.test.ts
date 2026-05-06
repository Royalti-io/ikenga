import { describe, it, expect } from "vitest";
import {
  buildDuckingSchedule,
  buildDuckingScheduleFromMs,
  getVolumeAtFrame,
  type DuckingSchedule,
} from "./audio-ducking";
import { type TimelineEntry } from "./audio-timeline";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTimeline(entries: Array<{ start: number; end: number }>): TimelineEntry[] {
  return entries.map((e, i) => ({
    sectionId: `s${i}`,
    startFrame: e.start,
    endFrame: e.end,
    file: `audio/s${i}.mp3`,
    durationSec: (e.end - e.start) / 30,
  }));
}

// ── buildDuckingSchedule ──────────────────────────────────────────────────

describe("buildDuckingSchedule", () => {
  it("returns empty edges for empty timeline", () => {
    const schedule = buildDuckingSchedule([], 5);
    expect(schedule.edges).toEqual([]);
    expect(schedule.transitionFrames).toBe(5);
  });

  it("creates two edges per timeline entry", () => {
    const timeline = makeTimeline([{ start: 10, end: 50 }]);
    const schedule = buildDuckingSchedule(timeline, 5);
    expect(schedule.edges).toHaveLength(2);
    expect(schedule.edges[0]).toEqual({ frame: 10, ducking: true });
    expect(schedule.edges[1]).toEqual({ frame: 50, ducking: false });
  });

  it("handles multiple entries", () => {
    const timeline = makeTimeline([
      { start: 0, end: 30 },
      { start: 45, end: 75 },
    ]);
    const schedule = buildDuckingSchedule(timeline, 5);
    expect(schedule.edges).toHaveLength(4);
  });
});

// ── buildDuckingScheduleFromMs ────────────────────────────────────────────

describe("buildDuckingScheduleFromMs", () => {
  it("converts ms to frames correctly", () => {
    const schedule = buildDuckingScheduleFromMs(
      [{ startMs: 0, endMs: 1000 }],
      30,
      5,
    );
    expect(schedule.edges[0].frame).toBe(0);
    expect(schedule.edges[1].frame).toBe(30); // 1000ms * 30fps / 1000
  });
});

// ── getVolumeAtFrame ──────────────────────────────────────────────────────

describe("getVolumeAtFrame", () => {
  const BASE = 0.4;
  const DUCKED = 0.15;
  const TRANSITION = 5;

  it("returns base volume for empty schedule", () => {
    const schedule: DuckingSchedule = { edges: [], transitionFrames: TRANSITION };
    expect(getVolumeAtFrame(0, schedule, BASE, DUCKED)).toBe(BASE);
    expect(getVolumeAtFrame(100, schedule, BASE, DUCKED)).toBe(BASE);
  });

  it("returns base volume before any edge", () => {
    const timeline = makeTimeline([{ start: 30, end: 60 }]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);
    expect(getVolumeAtFrame(0, schedule, BASE, DUCKED)).toBe(BASE);
    expect(getVolumeAtFrame(20, schedule, BASE, DUCKED)).toBe(BASE);
  });

  it("returns fully ducked volume well inside voice region", () => {
    const timeline = makeTimeline([{ start: 10, end: 100 }]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);
    // At frame 50, well past the 5-frame transition from frame 10
    expect(getVolumeAtFrame(50, schedule, BASE, DUCKED)).toBe(DUCKED);
  });

  it("returns base volume well after voice ends", () => {
    const timeline = makeTimeline([{ start: 10, end: 50 }]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);
    // Frame 100: well after voice ends at 50 + 5 transition
    expect(getVolumeAtFrame(100, schedule, BASE, DUCKED)).toBe(BASE);
  });

  it("transitions smoothly at duck-down edge", () => {
    const timeline = makeTimeline([{ start: 20, end: 100 }]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);

    // At the exact edge, should be BASE (start of transition)
    const atEdge = getVolumeAtFrame(20, schedule, BASE, DUCKED);
    expect(atEdge).toBe(BASE);

    // Midway through transition
    const mid = getVolumeAtFrame(22, schedule, BASE, DUCKED);
    expect(mid).toBeGreaterThan(DUCKED);
    expect(mid).toBeLessThan(BASE);

    // End of transition
    const end = getVolumeAtFrame(25, schedule, BASE, DUCKED);
    expect(end).toBe(DUCKED);
  });

  it("transitions smoothly at duck-up edge", () => {
    const timeline = makeTimeline([{ start: 10, end: 50 }]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);

    // At voice end (frame 50), ducking: false starts transitioning up
    const atEdge = getVolumeAtFrame(50, schedule, BASE, DUCKED);
    expect(atEdge).toBe(DUCKED); // Start of transition = from value

    // Midway
    const mid = getVolumeAtFrame(52, schedule, BASE, DUCKED);
    expect(mid).toBeGreaterThan(DUCKED);
    expect(mid).toBeLessThan(BASE);

    // End of transition
    const end = getVolumeAtFrame(55, schedule, BASE, DUCKED);
    expect(end).toBe(BASE);
  });

  it("handles multiple voice regions", () => {
    const timeline = makeTimeline([
      { start: 10, end: 40 },
      { start: 60, end: 90 },
    ]);
    const schedule = buildDuckingSchedule(timeline, TRANSITION);

    // Between regions (fully unducked after transition)
    expect(getVolumeAtFrame(50, schedule, BASE, DUCKED)).toBe(BASE);

    // In second region
    expect(getVolumeAtFrame(75, schedule, BASE, DUCKED)).toBe(DUCKED);
  });
});
