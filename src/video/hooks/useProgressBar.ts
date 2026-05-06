/**
 * useProgressBar — single-element spring animation (0→1).
 *
 * Used for headers, badges, hub nodes, titles — anything that enters
 * as a single unit without stagger. Returns a spring progress value
 * and derived opacity/scale/translate helpers.
 */

import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SPRING_CONFIGS } from "../config/defaults";
import type { SpringConfig } from "./useStaggeredReveal";

export interface UseProgressBarOptions {
  /** Delay before animation starts (frames). Default: 0 */
  delay?: number;
  /** Spring physics config. Default: SPRING_CONFIGS.GENTLE */
  springConfig?: SpringConfig;
}

export interface UseProgressBarResult {
  /** Raw spring progress (0–1). */
  progress: number;
  /** Opacity derived from progress. */
  opacity: number;
  /** TranslateY value (offset→0). */
  translateY: (offset?: number) => number;
  /** Scale value (from→1). */
  scale: (from?: number) => number;
}

export function useProgressBar(
  options: UseProgressBarOptions = {},
): UseProgressBarResult {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { delay = 0, springConfig = SPRING_CONFIGS.GENTLE } = options;

  const progress = spring({
    frame: frame - delay,
    fps,
    config: springConfig,
  });

  return {
    progress,
    opacity: interpolate(progress, [0, 1], [0, 1]),
    translateY: (offset = 20) => interpolate(progress, [0, 1], [offset, 0]),
    scale: (from = 0.8) => interpolate(progress, [0, 1], [from, 1]),
  };
}
