import React from "react";
import { AbsoluteFill } from "remotion";
import { VIDEO_COLORS } from "../../config/defaults";

export type SplitRatio = "50-50" | "60-40" | "40-60";

export interface SplitLayoutProps {
  left: React.ReactNode;
  right: React.ReactNode;
  ratio?: SplitRatio;
  gap?: number;
  backgroundColor?: string;
  padding?: number;
}

const ratioMap: Record<SplitRatio, [string, string]> = {
  "50-50": ["1", "1"],
  "60-40": ["3", "2"],
  "40-60": ["2", "3"],
};

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  left,
  right,
  ratio = "50-50",
  gap = 40,
  backgroundColor = VIDEO_COLORS.background,
  padding = 60,
}) => {
  const [leftFlex, rightFlex] = ratioMap[ratio];

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        padding,
        gap,
      }}
    >
      <div style={{ flex: leftFlex, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {left}
      </div>
      <div style={{ flex: rightFlex, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {right}
      </div>
    </AbsoluteFill>
  );
};
