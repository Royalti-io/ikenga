import React from "react";
import { useCurrentFrame } from "remotion";

export interface StaggerProps {
  staggerDelay?: number;
  startAt?: number;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

/**
 * Staggers children by injecting incremented `startAt` props.
 * Children must accept a `startAt` prop (FadeIn, SlideIn, ScaleIn, etc.).
 * Children are hidden before their startAt frame.
 */
export const Stagger: React.FC<StaggerProps> = ({
  staggerDelay = 5,
  startAt = 0,
  style,
  className,
  children,
}) => {
  const frame = useCurrentFrame();

  return (
    <div style={style} className={className}>
      {React.Children.map(children, (child, index) => {
        if (!React.isValidElement(child)) return child;
        const childStartAt = startAt + index * staggerDelay;
        const visible = frame >= childStartAt;
        return (
          <div style={{ visibility: visible ? "visible" : "hidden" }}>
            {React.cloneElement(child as React.ReactElement<{ startAt?: number }>, {
              startAt: childStartAt,
            })}
          </div>
        );
      })}
    </div>
  );
};
