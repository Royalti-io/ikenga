/**
 * Motion vocabulary library for Royalti Video Engine.
 *
 * Pure functions — no React imports. Wraps Remotion's `spring()` and
 * `interpolate()` with curated named configs. Compositions import these
 * instead of writing ad-hoc spring configs.
 *
 * Usage:
 *   import { settle, snap, bloom, lag, lead, applyOffset, SPRINGS } from "@/video/motion";
 *
 *   const progress = settle({ frame, fps, startAt: cueFrame });
 *   // use progress for opacity, scale, translateY, etc.
 */

import { spring, interpolate } from "remotion";

// ── Spring config presets ─────────────────────────────────────────────────────

// Spring preset type — uses Partial<SpringConfig> since all fields are optional
// when passed to remotion's spring() config parameter.
export type SpringPreset = {
  damping: number;
  stiffness: number;
  mass: number;
};

/**
 * Named spring config presets.
 *
 * These are exported for advanced use (e.g. custom interpolations) but most
 * compositions should reach for the entrance helpers below instead.
 */
export const SPRINGS: Record<string, SpringPreset> = {
  /**
   * Heavy: settles deliberately. Use for cards, sections, body content.
   * Longest settle time (~35 frames at 30fps).
   */
  heavy: { damping: 18, stiffness: 90, mass: 1.0 },

  /**
   * Medium: balanced feel. Use for headlines, stat callouts, primary text.
   * Settles in ~25 frames at 30fps.
   */
  medium: { damping: 14, stiffness: 110, mass: 0.7 },

  /**
   * Light: crisp and snappy. Use for icons, badges, small accents.
   * Settles in ~18 frames at 30fps.
   */
  light: { damping: 12, stiffness: 130, mass: 0.6 },

  /**
   * Bouncy: playful with overshoot. Use for avatars, bloom entrances, bursts.
   * Overshoots ~8% before settling (~22 frames at 30fps).
   */
  bouncy: { damping: 9, stiffness: 150, mass: 0.5 },
} as const;

// ── Shared args type ──────────────────────────────────────────────────────────

export interface EntranceArgs {
  /** Current composition frame. */
  frame: number;
  /** Composition fps. */
  fps: number;
  /**
   * Frame at which the entrance begins. All frames before this return 0.
   * Defaults to 0.
   */
  startAt?: number;
}

// ── Entrance helpers ──────────────────────────────────────────────────────────

/**
 * Settle — gentle, deliberate landing.
 *
 * Best for: body content, list items, paragraphs, card sections.
 * Spring: SPRINGS.heavy (damping 18, stiffness 90, mass 1.0).
 * Returns a 0→1 progress value suitable for opacity, scale, translateY, etc.
 *
 * @example
 *   const p = settle({ frame, fps, startAt: 12 });
 *   style={{ opacity: p, transform: `translateY(${interpolate(p, [0,1], [20,0])}px)` }}
 */
export function settle({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.heavy,
  });
}

/**
 * Snap — crisp, punctuated entrance.
 *
 * Best for: headlines, callouts, single-word emphasis, labels.
 * Spring: SPRINGS.light (damping 12, stiffness 130, mass 0.6).
 * Returns a 0→1 progress value.
 *
 * @example
 *   const p = snap({ frame, fps, startAt: beatFrame });
 *   style={{ opacity: p, transform: `scale(${interpolate(p, [0,1], [0.85,1])})` }}
 */
export function snap({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.light,
    durationInFrames: 20,
  });
}

/**
 * Bloom — radial scale with slight overshoot.
 *
 * Best for: avatars, stat numerals, badge reveals, burst animations.
 * Spring: SPRINGS.bouncy (damping 9, stiffness 150, mass 0.5).
 * Returns a 0→1+ progress value (may exceed 1 briefly due to overshoot).
 *
 * @example
 *   const p = bloom({ frame, fps, startAt: beatFrame });
 *   style={{ transform: `scale(${p})`, opacity: Math.min(p, 1) }}
 */
export function bloom({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.bouncy,
  });
}

// ── Timing offset helpers ─────────────────────────────────────────────────────

export interface FrameOffset {
  /** Convert this offset to a number of frames at the given fps. */
  offsetFrames: (fps: number) => number;
  /** The offset in milliseconds (positive = later). */
  ms: number;
}

/**
 * Lag — shift an entrance `ms` milliseconds later than its cue frame.
 *
 * Use when a visual should land slightly after the narration word that
 * triggers it (e.g. a card appears 200ms after "Meet" is spoken).
 *
 * @example
 *   const offset = lag(200);
 *   const startAt = applyOffset(cueFrame, offset, fps);
 *   const p = settle({ frame, fps, startAt });
 */
export function lag(ms: number): FrameOffset {
  return {
    ms,
    offsetFrames: (fps: number) => Math.round((ms / 1000) * fps),
  };
}

/**
 * Lead — shift an entrance `ms` milliseconds earlier than its cue frame.
 *
 * Use when a visual should appear slightly before the narration cue
 * (e.g. a diagram fades in 100ms before the audio emphasis word).
 *
 * @example
 *   const offset = lead(100);
 *   const startAt = applyOffset(cueFrame, offset, fps);
 */
export function lead(ms: number): FrameOffset {
  return {
    ms: ms === 0 ? 0 : -ms,
    offsetFrames: (fps: number) => {
      const frames = Math.round((ms / 1000) * fps);
      return frames === 0 ? 0 : -frames;
    },
  };
}

/**
 * Apply a lag/lead offset to a base frame number.
 *
 * Clamps to 0 — a startAt frame can never go negative.
 *
 * @example
 *   applyOffset(40, lag(200), 30)  // → 46  (40 + 6)
 *   applyOffset(5,  lead(300), 30) // → 0   (5 - 9, clamped to 0)
 */
export function applyOffset(
  frame: number,
  offset: FrameOffset,
  fps: number,
): number {
  return Math.max(0, frame + offset.offsetFrames(fps));
}

// ── Re-export interpolate for composition convenience ─────────────────────────

/**
 * Re-exported from Remotion so composition files can do:
 *   import { settle, interpolate } from "@/video/motion";
 * without needing a separate `import { interpolate } from "remotion"`.
 */
export { interpolate };
