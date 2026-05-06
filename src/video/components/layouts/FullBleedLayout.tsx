import React from "react";
import { AbsoluteFill } from "remotion";

export type GradientDirection = "bottom" | "top" | "full" | "none";

export interface FullBleedLayoutProps {
  children: React.ReactNode;
  overlayGradient?: GradientDirection;
  overlayColor?: string;
}

const getGradient = (direction: GradientDirection, color: string): string => {
  switch (direction) {
    case "bottom":
      return `linear-gradient(to bottom, transparent 30%, ${color})`;
    case "top":
      return `linear-gradient(to top, transparent 30%, ${color})`;
    case "full":
      return `linear-gradient(to bottom, ${color}, transparent 30%, transparent 70%, ${color})`;
    default:
      return "none";
  }
};

export const FullBleedLayout: React.FC<FullBleedLayoutProps> = ({
  children,
  overlayGradient = "none",
  overlayColor = "rgba(0, 0, 0, 0.7)",
}) => {
  return (
    <AbsoluteFill>
      {children}
      {overlayGradient !== "none" && (
        <AbsoluteFill
          style={{
            background: getGradient(overlayGradient, overlayColor),
          }}
        />
      )}
    </AbsoluteFill>
  );
};
