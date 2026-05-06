/**
 * useActiveBeat — resolves which beat the current composition frame falls in.
 *
 * Auto-pulls beats from StoryboardProvider if no beats argument is passed.
 * Falls back gracefully when neither source provides beats.
 *
 * The hook is also split into a pure helper `resolveActiveBeat(frame, beats)`
 * which is exported for testing and non-hook usage (e.g. SSR stills).
 *
 * Beat boundaries:
 *   - A frame at exactly `beat.frames.start` is INSIDE that beat.
 *   - A frame at exactly `beat.frames.end` is OUTSIDE (belongs to next beat).
 *   - This matches the half-open interval convention [start, end).
 *
 * @example
 *   // Inside a Remotion component:
 *   const { beat, frameInBeat, index } = useActiveBeat();
 *   // Or with an explicit beats array:
 *   const { beat, frameInBeat } = useActiveBeat(myBeats);
 */

import { useCurrentFrame } from "remotion";
import { useStoryboard } from "@/video/remotion-ui/themes/StoryboardProvider";
import type { Beat } from "@/video/lib/define-beats";

// ── Return type ────────────────────────────────────────────────────────────────

export interface ActiveBeatResult {
  /** The beat the current frame falls within, or null if none. */
  beat: Beat | null;
  /** Frame within the beat (0 = first frame of beat). */
  frameInBeat: number;
  /** Index of beat in the array (-1 if none matched). */
  index: number;
}

// ── Pure resolver (exported for testing + SSR) ─────────────────────────────────

/**
 * Pure function — resolves the active beat for an arbitrary frame number.
 *
 * Uses `beat.frames` if present (filled by defineBeats), otherwise falls back
 * to `beat.time` converted at 30fps. If both are absent the beat is skipped.
 *
 * @param frame  Current composition frame (absolute).
 * @param beats  Array of beats as returned by defineBeats().
 */
export function resolveActiveBeat(frame: number, beats: Beat[]): ActiveBeatResult {
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];

    let startFrame: number;
    let endFrame: number;

    if (beat.frames) {
      startFrame = beat.frames.start;
      endFrame = beat.frames.end;
    } else {
      // Fallback: use time × 30fps (matches defineBeats default)
      startFrame = Math.floor(beat.time.start * 30);
      endFrame = Math.floor(beat.time.end * 30);
    }

    // Half-open interval: [startFrame, endFrame)
    if (frame >= startFrame && frame < endFrame) {
      return {
        beat,
        frameInBeat: frame - startFrame,
        index: i,
      };
    }
  }

  return { beat: null, frameInBeat: 0, index: -1 };
}

// ── React hook ─────────────────────────────────────────────────────────────────

/**
 * Hook — returns the active beat for the current Remotion frame.
 *
 * When `beats` is omitted the hook reads from the nearest StoryboardProvider.
 * If neither provides beats, returns `{ beat: null, frameInBeat: 0, index: -1 }`.
 *
 * Must be called inside a Remotion composition (requires useCurrentFrame).
 */
export function useActiveBeat(beats?: Beat[]): ActiveBeatResult {
  const frame = useCurrentFrame();
  const storyboard = useStoryboard();

  const resolvedBeats = beats ?? storyboard.beats;

  if (!resolvedBeats || resolvedBeats.length === 0) {
    return { beat: null, frameInBeat: 0, index: -1 };
  }

  return resolveActiveBeat(frame, resolvedBeats);
}
