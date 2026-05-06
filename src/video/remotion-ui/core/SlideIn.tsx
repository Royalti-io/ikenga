import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing, type EasingType } from "./easing";

export type SlideDirection = "left" | "right" | "top" | "bottom";

export interface SlideInProps {
  from?: SlideDirection;
  distance?: number;
  startAt?: number;
  durationInFrames?: number;
  easing?: EasingType;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const getTransform = (from: SlideDirection, distance: number, progress: number): string => {
  const offset = distance * (1 - progress);
  switch (from) {
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

export const SlideIn: React.FC<SlideInProps> = ({
  from = "bottom",
  distance = 50,
  startAt = 0,
  durationInFrames = 20,
  easing = "ease-out",
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
    [0, 1],
    easing,
  );

  return (
    <div
      style={{
        opacity,
        transform: getTransform(from, distance, progress),
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  );
};
