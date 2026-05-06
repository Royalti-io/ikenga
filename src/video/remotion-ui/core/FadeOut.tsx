import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";

export interface FadeOutProps {
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

export const FadeOut: React.FC<FadeOutProps> = ({
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-in",
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [1, 0],
    easing,
  );

  return (
    <div style={{ opacity, ...style }} className={className}>
      {children}
    </div>
  );
};
