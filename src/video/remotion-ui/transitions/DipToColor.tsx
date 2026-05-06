import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";

export interface DipToColorProps {
  from: React.ReactNode;
  to: React.ReactNode;
  color?: string;
  startAt?: number;
  durationInFrames?: number;
}

export const DipToColor: React.FC<DipToColorProps> = ({
  from,
  to,
  color = "#000000",
  startAt = 0,
  durationInFrames = 30,
}) => {
  const frame = useCurrentFrame();
  const half = durationInFrames / 2;

  // Dip overlay fades in for first half, fades out for second half
  // Offset middle values by 1 frame to satisfy strictly-increasing requirement
  const dipOpacity = interpolate(
    frame,
    [startAt, startAt + half, startAt + half + 1, startAt + durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Show "from" in first half, "to" in second half
  const showTo = frame >= startAt + half;

  return (
    <AbsoluteFill>
      <AbsoluteFill>{showTo ? to : from}</AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: color, opacity: dipOpacity }} />
    </AbsoluteFill>
  );
};
