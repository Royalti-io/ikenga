/**
 * useLineDrawSVG — SVG stroke-dashoffset line-draw animation.
 *
 * Used by FlowChart arrows, Timeline axis, HubSpoke spoke lines.
 * Returns strokeDasharray and strokeDashoffset for a <line> or <path>.
 */

import { useCurrentFrame, interpolate } from "remotion";

export interface UseLineDrawSVGOptions {
  /** Total path length (measure with SVG getTotalLength or estimate). */
  totalLength: number;
  /** Delay before draw starts (frames). Default: 0 */
  delay?: number;
  /** Duration of the draw animation (frames). Default: 20 */
  durationFrames?: number;
}

export interface UseLineDrawSVGResult {
  /** Set as the SVG strokeDasharray attribute. */
  strokeDasharray: string;
  /** Set as the SVG strokeDashoffset attribute. Animates from totalLength→0. */
  strokeDashoffset: number;
  /** Draw progress (0–1). Useful for triggering follow-up animations. */
  progress: number;
}

export function useLineDrawSVG(
  options: UseLineDrawSVGOptions,
): UseLineDrawSVGResult {
  const frame = useCurrentFrame();

  const { totalLength, delay = 0, durationFrames = 20 } = options;

  const progress = interpolate(
    frame - delay,
    [0, durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return {
    strokeDasharray: `${totalLength}`,
    strokeDashoffset: totalLength * (1 - progress),
    progress,
  };
}
