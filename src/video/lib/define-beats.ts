/**
 * defineBeats() — composition-side helper for declaring the beat timeline.
 *
 * Call once at the top of each composition file; pass the result to
 * <StoryboardProvider beats={...}>. The same array is serialised into
 * storyboard.json so the storyboard app can read it without importing
 * composition code.
 *
 * Validation (throws in development, logs in production):
 *   - beats are sorted by time.start (ascending)
 *   - no two beats overlap
 *   - time.start >= 0, time.end > time.start
 *
 * Frame computation:
 *   If `frames` is omitted, it is computed from time × fps.
 *   Fractional results are floored to the nearest integer frame.
 */

import { FPS as DEFAULT_FPS } from "../config/defaults";

// ── Types ──────────────────────────────────────────────────────────────────

export type Beat = {
  /** Unique identifier within this composition. Use kebab-case. */
  id: string;
  /** Human-readable label shown in the storyboard app. */
  label: string;
  /** Time range in seconds (composition-absolute). */
  time: { start: number; end: number };
  /** Frame range at composition fps. Auto-computed if omitted. */
  frames?: { start: number; end: number };
  /** Short narration excerpt for storyboard annotations. */
  narration_excerpt?: string;
  /** Design intent — free-form note for the storyboard app. */
  intent?: string;
};

export interface DefineBeatsOptions {
  /** Frames-per-second. Defaults to FPS from config/defaults.ts (30). */
  fps?: number;
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateBeats(beats: Beat[]): void {
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];

    if (b.time.start < 0) {
      throw new Error(
        `defineBeats: beat "${b.id}" has time.start < 0 (${b.time.start})`,
      );
    }

    if (b.time.end <= b.time.start) {
      throw new Error(
        `defineBeats: beat "${b.id}" has time.end (${b.time.end}) ≤ time.start (${b.time.start})`,
      );
    }

    if (i > 0) {
      const prev = beats[i - 1];

      // Sort check
      if (b.time.start < prev.time.start) {
        throw new Error(
          `defineBeats: beats are not sorted — beat "${b.id}" starts at ${b.time.start}s ` +
          `but previous beat "${prev.id}" starts at ${prev.time.start}s`,
        );
      }

      // Overlap check
      if (b.time.start < prev.time.end) {
        throw new Error(
          `defineBeats: beats "${prev.id}" and "${b.id}" overlap — ` +
          `"${prev.id}" ends at ${prev.time.end}s, "${b.id}" starts at ${b.time.start}s`,
        );
      }
    }
  }
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Validate beats and fill in computed `frames` where omitted.
 *
 * @example
 * const beats = defineBeats([
 *   { id: "hook",    label: "Hook",    time: { start: 0, end: 3.8 } },
 *   { id: "problem", label: "Problem", time: { start: 3.8, end: 15.27 } },
 * ], { fps: 30 });
 */
export function defineBeats(beats: Beat[], opts?: DefineBeatsOptions): Beat[] {
  const fps = opts?.fps ?? DEFAULT_FPS;

  validateBeats(beats);

  return beats.map((b) => {
    if (b.frames) return b;
    return {
      ...b,
      frames: {
        start: Math.floor(b.time.start * fps),
        end: Math.floor(b.time.end * fps),
      },
    };
  });
}
