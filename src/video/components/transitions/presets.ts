/**
 * Transition presets for @remotion/transitions.
 *
 * Two levels:
 * - SECTION_* — between major sections (15-20 frames, smooth)
 * - BEAT_* — between beats within a section (8-12 frames, snappy)
 *
 * Usage with TransitionSeries:
 *   <TransitionSeries.Transition
 *     presentation={preset.presentation}
 *     timing={preset.timing}
 *   />
 */

import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { linearTiming, springTiming } from "@remotion/transitions";
import { WIDTH, HEIGHT } from "../../config/defaults";

/** Transition names between beats — used by resolveBeatTransition. */
export type BeatTransition =
  | "cut"
  | "fade"
  | "slide_left"
  | "slide_right"
  | "zoom_in"
  | "zoom_out"
  | "push_left"
  | "push_right"
  | "wipe_left"
  | "clock_wipe";

// ── Types ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TransitionPreset {
  presentation: any; // TransitionPresentation<T> varies by type — use any for the union
  timing: ReturnType<typeof linearTiming> | ReturnType<typeof springTiming>;
}

// ── Section-level Transitions (between major sections) ────────────────────

/** Smooth cross-fade between scenes (15 frames). */
export const SECTION_FADE: TransitionPreset = {
  presentation: fade(),
  timing: linearTiming({ durationInFrames: 15 }),
};

/** Slide in from left with spring easing. */
export const SECTION_SLIDE_LEFT: TransitionPreset = {
  presentation: slide({ direction: "from-left" }),
  timing: springTiming({ config: { damping: 200 } }),
};

/** Slide in from right with spring easing. */
export const SECTION_SLIDE_RIGHT: TransitionPreset = {
  presentation: slide({ direction: "from-right" }),
  timing: springTiming({ config: { damping: 200 } }),
};

/** Wipe reveal from left (20 frames). */
export const SECTION_WIPE: TransitionPreset = {
  presentation: wipe({ direction: "from-left" }),
  timing: linearTiming({ durationInFrames: 20 }),
};

/** Radial clock wipe (20 frames). */
export const SECTION_CLOCK: TransitionPreset = {
  presentation: clockWipe({ width: WIDTH, height: HEIGHT }),
  timing: linearTiming({ durationInFrames: 20 }),
};

// ── Beat-level Transitions (within sections, snappy) ──────────────────────

/** Quick cross-fade (8 frames). */
export const BEAT_FADE: TransitionPreset = {
  presentation: fade(),
  timing: linearTiming({ durationInFrames: 8 }),
};

/** Slide in from left, spring snap (beat-level). */
export const BEAT_SLIDE_LEFT: TransitionPreset = {
  presentation: slide({ direction: "from-left" }),
  timing: springTiming({ config: { damping: 300, stiffness: 200 } }),
};

/** Slide in from right, spring snap (beat-level). */
export const BEAT_SLIDE_RIGHT: TransitionPreset = {
  presentation: slide({ direction: "from-right" }),
  timing: springTiming({ config: { damping: 300, stiffness: 200 } }),
};

/** Push from left (content slides together). */
export const BEAT_PUSH_LEFT: TransitionPreset = {
  presentation: slide({ direction: "from-left" }),
  timing: linearTiming({ durationInFrames: 10 }),
};

/** Push from right (content slides together). */
export const BEAT_PUSH_RIGHT: TransitionPreset = {
  presentation: slide({ direction: "from-right" }),
  timing: linearTiming({ durationInFrames: 10 }),
};

/** Wipe from left (beat-level, 10 frames). */
export const BEAT_WIPE: TransitionPreset = {
  presentation: wipe({ direction: "from-left" }),
  timing: linearTiming({ durationInFrames: 10 }),
};

/** Clock wipe (beat-level, 12 frames). */
export const BEAT_CLOCK: TransitionPreset = {
  presentation: clockWipe({ width: WIDTH, height: HEIGHT }),
  timing: linearTiming({ durationInFrames: 12 }),
};

/** Zoom-in fade (combined scale + opacity). Uses fade as base. */
export const BEAT_ZOOM_IN: TransitionPreset = {
  presentation: fade(),
  timing: linearTiming({ durationInFrames: 10 }),
};

/** Zoom-out fade. */
export const BEAT_ZOOM_OUT: TransitionPreset = {
  presentation: fade(),
  timing: linearTiming({ durationInFrames: 10 }),
};

// ── Beat Transition Resolver ──────────────────────────────────────────────

/** Map a BeatTransition enum value to a TransitionPreset (or null for hard cut). */
export function resolveBeatTransition(
  transition: BeatTransition,
): TransitionPreset | null {
  switch (transition) {
    case "cut":
      return null;
    case "fade":
      return BEAT_FADE;
    case "slide_left":
      return BEAT_SLIDE_LEFT;
    case "slide_right":
      return BEAT_SLIDE_RIGHT;
    case "zoom_in":
      return BEAT_ZOOM_IN;
    case "zoom_out":
      return BEAT_ZOOM_OUT;
    case "push_left":
      return BEAT_PUSH_LEFT;
    case "push_right":
      return BEAT_PUSH_RIGHT;
    case "wipe_left":
      return BEAT_WIPE;
    case "clock_wipe":
      return BEAT_CLOCK;
    default:
      return null;
  }
}

/** Frames consumed by a beat transition (for duration calculations). */
export function beatTransitionFrames(transition: BeatTransition): number {
  switch (transition) {
    case "cut":
      return 0;
    case "fade":
      return 8;
    case "slide_left":
    case "slide_right":
      return 10;
    case "zoom_in":
    case "zoom_out":
      return 10;
    case "push_left":
    case "push_right":
      return 10;
    case "wipe_left":
      return 10;
    case "clock_wipe":
      return 12;
    default:
      return 0;
  }
}
