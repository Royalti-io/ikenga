/**
 * LottieAnimation — renders Lottie/Bodymovin animations in Remotion compositions.
 *
 * Loads Lottie JSON from staticFile() and plays frame-synced animations.
 * Uses delayRender/continueRender for async loading.
 *
 * @example
 * <LottieAnimation src="lottie/logo-reveal.json" />
 * <LottieAnimation src="lottie/icon-check.json" loop speed={1.5} />
 */

import React, { useCallback, useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { Lottie, getLottieMetadata, type LottieAnimationData } from "@remotion/lottie";

export interface LottieAnimationProps {
  /** Path relative to public/ directory (e.g. "lottie/logo-reveal.json") */
  src: string;
  /** Loop the animation. Default: false */
  loop?: boolean;
  /** Playback speed multiplier. Default: 1 */
  speed?: number;
  /** Playback direction. Default: "forward" */
  direction?: "forward" | "backward";
  /** Lottie renderer. Default: "svg" */
  renderer?: "svg" | "canvas" | "html";
  /** Container style overrides */
  style?: React.CSSProperties;
}

export const LottieAnimation: React.FC<LottieAnimationProps> = ({
  src,
  loop = false,
  speed = 1,
  direction = "forward",
  renderer = "svg",
  style,
}) => {
  const [handle] = useState(() => delayRender("Loading Lottie animation"));
  const [animationData, setAnimationData] = useState<LottieAnimationData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(staticFile(src));
      const data = await response.json();
      setAnimationData(data);
      continueRender(handle);
    } catch (err) {
      console.error(`Failed to load Lottie animation: ${src}`, err);
      continueRender(handle);
    }
  }, [src, handle]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!animationData) {
    return null;
  }

  return (
    <div style={{ width: "100%", height: "100%", ...style }}>
      <Lottie
        animationData={animationData}
        loop={loop}
        playbackRate={speed}
        direction={direction}
        renderer={renderer}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
};

/**
 * Helper to get Lottie animation metadata for calculating durationInFrames.
 *
 * @example
 * const meta = await getLottieDuration("lottie/logo.json", 30);
 * // meta.durationInFrames, meta.fps, meta.width, meta.height
 */
export async function getLottieDuration(
  src: string,
  compositionFps: number,
): Promise<{ durationInFrames: number; fps: number; width: number; height: number }> {
  const response = await fetch(staticFile(src));
  const data = await response.json();
  const metadata = getLottieMetadata(data);

  if (!metadata) {
    return { durationInFrames: 90, fps: compositionFps, width: 1920, height: 1080 };
  }

  return {
    durationInFrames: metadata.durationInSeconds * compositionFps,
    fps: metadata.fps ?? compositionFps,
    width: metadata.width ?? 1920,
    height: metadata.height ?? 1080,
  };
}
