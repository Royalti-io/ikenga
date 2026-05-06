import React from "react";
import { useCurrentFrame } from "remotion";

export interface TimelineGateProps {
  showAfter: number;
  hideAfter?: number;
  children: React.ReactNode;
}

/**
 * Conditionally renders children based on current frame.
 * Shows content only within the specified frame range.
 */
export const TimelineGate: React.FC<TimelineGateProps> = ({
  showAfter,
  hideAfter,
  children,
}) => {
  const frame = useCurrentFrame();

  if (frame < showAfter) return null;
  if (hideAfter !== undefined && frame >= hideAfter) return null;

  return <>{children}</>;
};
