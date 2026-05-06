/**
 * useStaggeredReveal — staggered spring entry animation for lists of items.
 *
 * Encapsulates the universal pattern found in all 10 diagram components:
 *   delay + i * stagger → spring() → interpolate() for opacity/translate/scale
 *
 * Returns closures per item index — components call getItemOpacity(i), etc.
 * in their render loop instead of duplicating spring/interpolate inline.
 */

import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SPRING_CONFIGS } from "../config/defaults";

export interface SpringConfig {
  damping: number;
  stiffness: number;
  mass?: number;
}

export interface UseStaggeredRevealOptions {
  /** Number of items to animate. */
  count: number;
  /** Frames between each item's entry. Default: 10 */
  stagger?: number;
  /** Global delay before first item enters (frames). Default: 0 */
  delay?: number;
  /** Spring physics config. Default: SPRING_CONFIGS.GENTLE */
  springConfig?: SpringConfig;
}

export interface UseStaggeredRevealResult {
  /** Raw spring progress (0–1) for item at index. */
  getItemProgress: (index: number) => number;
  /** Opacity (0–1) for item at index. */
  getItemOpacity: (index: number) => number;
  /** TranslateY value (px) for item at index. Default: 20→0. */
  getItemTranslateY: (index: number, offset?: number) => number;
  /** TranslateX value (px) for item at index. Default: -80→0. */
  getItemTranslateX: (index: number, offset?: number) => number;
  /** Scale value for item at index. Default: 0.8→1. */
  getItemScale: (index: number, from?: number) => number;
  /** How many items have entered (progress > 0.01). */
  visibleCount: number;
}

export function useStaggeredReveal(
  options: UseStaggeredRevealOptions,
): UseStaggeredRevealResult {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const {
    count,
    stagger = 10,
    delay = 0,
    springConfig = SPRING_CONFIGS.GENTLE,
  } = options;

  // Cache spring values per render (one frame = one call)
  const progressCache: number[] = [];
  for (let i = 0; i < count; i++) {
    const itemDelay = delay + i * stagger;
    progressCache[i] = spring({
      frame: frame - itemDelay,
      fps,
      config: springConfig,
    });
  }

  const getItemProgress = (index: number) => progressCache[index] ?? 0;

  const getItemOpacity = (index: number) =>
    interpolate(getItemProgress(index), [0, 1], [0, 1]);

  const getItemTranslateY = (index: number, offset = 20) =>
    interpolate(getItemProgress(index), [0, 1], [offset, 0]);

  const getItemTranslateX = (index: number, offset = -80) =>
    interpolate(getItemProgress(index), [0, 1], [offset, 0]);

  const getItemScale = (index: number, from = 0.8) =>
    interpolate(getItemProgress(index), [0, 1], [from, 1]);

  const visibleCount = progressCache.filter((p) => p > 0.01).length;

  return {
    getItemProgress,
    getItemOpacity,
    getItemTranslateY,
    getItemTranslateX,
    getItemScale,
    visibleCount,
  };
}
