/**
 * Hook that returns the current aspect ratio category based on video dimensions.
 *
 * Uses useVideoConfig() internally — only call inside Remotion compositions.
 */

import { useVideoConfig } from "remotion";

export type AspectRatioType = "landscape" | "portrait" | "square";

export function useAspectRatio(): AspectRatioType {
  const { width, height } = useVideoConfig();
  const ratio = width / height;

  if (ratio > 1.2) return "landscape";
  if (ratio < 0.8) return "portrait";
  return "square";
}
