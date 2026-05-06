import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";
import type { SlideDirection } from "./SlideIn";

export interface SlideOutProps {
  to?: SlideDirection;
  distance?: number;
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const getTransform = (to: SlideDirection, distance: number, progress: number): string => {
  const offset = distance * progress;
  switch (to) {
    case "left":
      return `translateX(${-offset}px)`;
    case "right":
      return `translateX(${offset}px)`;
    case "top":
      return `translateY(${-offset}px)`;
    case "bottom":
      return `translateY(${offset}px)`;
  }
};

export const SlideOut: React.FC<SlideOutProps> = ({
  to = "bottom",
  distance = 50,
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-in",
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, 1],
    easing,
  );
  const opacity = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [1, 0],
    easing,
  );

  return (
    <div
      style={{
        opacity,
        transform: getTransform(to, distance, progress),
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  );
};
