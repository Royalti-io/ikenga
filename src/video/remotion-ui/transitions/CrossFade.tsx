import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { interpolateWithEasing } from "../core/easing";

export interface CrossFadeProps {
  from: React.ReactNode;
  to: React.ReactNode;
  startAt?: number;
  durationInFrames?: number;
}

export const CrossFade: React.FC<CrossFadeProps> = ({
  from,
  to,
  startAt = 0,
  durationInFrames = 20,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, 1],
    "ease-in-out",
  );

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - progress }}>{from}</AbsoluteFill>
      <AbsoluteFill style={{ opacity: progress }}>{to}</AbsoluteFill>
    </AbsoluteFill>
  );
};
