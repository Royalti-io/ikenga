import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";

export interface FadeInProps {
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

export const FadeIn: React.FC<FadeInProps> = ({
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-out",
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, 1],
    easing,
  );

  return (
    <div style={{ opacity, ...style }} className={className}>
      {children}
    </div>
  );
};
