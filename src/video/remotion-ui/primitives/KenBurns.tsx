/**
 * KenBurns — wraps children in a slow zoom (and optional pan) effect.
 * Default: 1.08 → 1.0 over 6s, linear. Lofi: disabled (scale 1.0).
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";

type Origin = "center" | "top" | "bottom" | "left" | "right" | { x: number; y: number };

export type KenBurnsProps = {
  from?: number;
  to?: number;
  duration?: number;
  origin?: Origin;
  pan?: { fromX?: number; fromY?: number; toX?: number; toY?: number };
  easing?: "linear" | "ease-in-out";
  children?: React.ReactNode;
};

function resolveOrigin(origin: Origin): string {
  if (typeof origin === "string") return origin;
  return `${origin.x * 100}% ${origin.y * 100}%`;
}

export const KenBurns: React.FC<KenBurnsProps> = ({
  from = 1.08,
  to = 1.0,
  duration = 6,
  origin = "center",
  pan,
  easing = "linear",
  children,
}) => {
  const palette = usePalette();
  const isLofi = palette.lofi === true;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (isLofi) {
    return (
      <AbsoluteFill style={{ transform: "scale(1)", transformOrigin: "center" }}>
        {children}
      </AbsoluteFill>
    );
  }

  const totalFrames = duration * fps;

  const easingFn =
    easing === "ease-in-out"
      ? ([0, 0.5, 1] as [number, number, number])
      : undefined;

  const scale = interpolate(frame, [0, totalFrames], [from, to], {
    extrapolateRight: "clamp",
    ...(easingFn ? { easing: (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t } : {}),
  });

  const tx = pan
    ? interpolate(frame, [0, totalFrames], [pan.fromX ?? 0, pan.toX ?? 0], { extrapolateRight: "clamp" })
    : 0;
  const ty = pan
    ? interpolate(frame, [0, totalFrames], [pan.fromY ?? 0, pan.toY ?? 0], { extrapolateRight: "clamp" })
    : 0;

  const transformOrigin = resolveOrigin(origin);
  const transform = `scale(${scale}) translate(${tx * 100}%, ${ty * 100}%)`;

  return (
    <AbsoluteFill style={{ transform, transformOrigin }}>
      {children}
    </AbsoluteFill>
  );
};
