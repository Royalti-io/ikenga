import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";

export interface ScaleInProps {
  initialScale?: number;
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

export const ScaleIn: React.FC<ScaleInProps> = ({
  initialScale = 0,
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-out-back",
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [initialScale, 1],
    easing,
  );
  const opacity = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, 1],
    "ease-out",
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
