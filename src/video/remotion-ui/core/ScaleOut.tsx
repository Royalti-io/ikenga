import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";

export interface ScaleOutProps {
  finalScale?: number;
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

export const ScaleOut: React.FC<ScaleOutProps> = ({
  finalScale = 0,
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-in-back",
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [1, finalScale],
    easing,
  );
  const opacity = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [1, 0],
    "ease-in",
  );

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  );
};
