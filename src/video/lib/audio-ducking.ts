/**
 * Shared audio ducking logic.
 *
 * Pre-computes ducking edge frames at timeline build time so that
 * per-frame volume lookups scan a small edge list instead of the full timeline.
 *
 * Used by BackgroundMusic and SfxTrigger.
 */

import { interpolate } from "remotion";
import { type TimelineEntry, isVoiceActiveAtFrame } from "./audio-timeline";

// ── Types ──────────────────────────────────────────────────────────────────

/** A pre-computed edge where voice activity changes state. */
export interface DuckingEdge {
  /** Frame where the transition starts */
  frame: number;
  /** Direction: true = voice becoming active (duck down), false = voice ending (duck up) */
  ducking: boolean;
}

/** Pre-computed schedule for fast per-frame volume lookups. */
export interface DuckingSchedule {
  edges: DuckingEdge[];
  transitionFrames: number;
}

// ── Schedule Builders ──────────────────────────────────────────────────────

/**
 * Build a ducking schedule from a voiceover timeline (frame-based).
 *
 * Scans the timeline to find every voice-activity edge and records it.
 * This is done once at timeline build time, not per-frame.
 */
export function buildDuckingSchedule(
  voiceTimeline: TimelineEntry[],
  transitionFrames: number = 5,
): DuckingSchedule {
  if (voiceTimeline.length === 0) {
    return { edges: [], transitionFrames };
  }

  const edges: DuckingEdge[] = [];

  for (const entry of voiceTimeline) {
    // Voice starts at startFrame
    edges.push({ frame: entry.startFrame, ducking: true });
    // Voice ends at endFrame
    edges.push({ frame: entry.endFrame, ducking: false });
  }

  // Sort by frame (should already be sorted, but be safe)
  edges.sort((a, b) => a.frame - b.frame);

  return { edges, transitionFrames };
}

/**
 * Convert ms-based voice entries to frame-based and build schedule.
 * Convenience wrapper for Phase 4+ ms-based scene data.
 */
export function buildDuckingScheduleFromMs(
  voiceEntries: Array<{ startMs: number; endMs: number }>,
  fps: number,
  transitionFrames: number = 5,
): DuckingSchedule {
  const timeline: TimelineEntry[] = voiceEntries.map((entry, i) => ({
    sectionId: `ms-${i}`,
    startFrame: Math.round((entry.startMs / 1000) * fps),
    endFrame: Math.round((entry.endMs / 1000) * fps),
    file: "",
    durationSec: (entry.endMs - entry.startMs) / 1000,
  }));

  return buildDuckingSchedule(timeline, transitionFrames);
}

// ── Per-frame Volume ───────────────────────────────────────────────────────

/**
 * Get the ducked volume at a given frame.
 *
 * Uses the pre-computed edge schedule to determine whether we're in a
 * ducked region, unducked region, or transition zone.
 *
 * @param frame - Current absolute frame
 * @param schedule - Pre-computed ducking schedule
 * @param baseVol - Volume when voice is NOT active
 * @param duckedVol - Volume when voice IS active
 * @returns Volume value at this frame
 */
export function getVolumeAtFrame(
  frame: number,
  schedule: DuckingSchedule,
  baseVol: number,
  duckedVol: number,
): number {
  const { edges, transitionFrames } = schedule;

  if (edges.length === 0) {
    return baseVol;
  }

  // Find the last edge at or before this frame
  let lastEdgeIdx = -1;
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].frame <= frame) {
      lastEdgeIdx = i;
      break;
    }
  }

  // Before any edge — unducked
  if (lastEdgeIdx === -1) {
    // Check if we're in the transition zone leading to the first edge
    const firstEdge = edges[0];
    if (frame >= firstEdge.frame - transitionFrames) {
      // We're approaching the first duck-down, but not there yet
      return baseVol;
    }
    return baseVol;
  }

  const lastEdge = edges[lastEdgeIdx];
  const framesSinceEdge = frame - lastEdge.frame;

  // Within transition zone of this edge
  if (framesSinceEdge < transitionFrames) {
    const [from, to] = lastEdge.ducking
      ? [baseVol, duckedVol]
      : [duckedVol, baseVol];

    return interpolate(
      frame,
      [lastEdge.frame, lastEdge.frame + transitionFrames],
      [from, to],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  }

  // Past transition — fully in the new state
  return lastEdge.ducking ? duckedVol : baseVol;
}

// ── Legacy compatibility ───────────────────────────────────────────────────

/**
 * Per-frame ducking volume using the original O(n) approach.
 * Kept for backward compatibility; prefer buildDuckingSchedule + getVolumeAtFrame.
 */
export function getDuckingVolumeLegacy(
  frame: number,
  voiceTimeline: TimelineEntry[],
  transitionFrames: number,
  baseVol: number,
  duckedVol: number,
): number {
  if (!voiceTimeline || voiceTimeline.length === 0) {
    return baseVol;
  }

  const activeNow = isVoiceActiveAtFrame(frame, voiceTimeline);
  const activeBefore = isVoiceActiveAtFrame(frame - transitionFrames, voiceTimeline);

  if (activeNow && activeBefore) {
    return duckedVol;
  }
  if (!activeNow && !activeBefore) {
    return baseVol;
  }

  // Transition zone — find the edge and interpolate
  let edgeFrame = frame;
  for (let f = frame; f > frame - transitionFrames; f--) {
    if (isVoiceActiveAtFrame(f, voiceTimeline) !== activeNow) {
      edgeFrame = f + (activeNow ? 1 : 0);
      break;
    }
  }
  const [from, to] = activeNow
    ? [baseVol, duckedVol]
    : [duckedVol, baseVol];

  return interpolate(
    frame,
    [edgeFrame, edgeFrame + transitionFrames],
    [from, to],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
}
