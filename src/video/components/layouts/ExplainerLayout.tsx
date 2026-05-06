import React from "react";
import { AbsoluteFill } from "remotion";
import { VIDEO_COLORS } from "../../config/defaults";

interface ExplainerLayoutProps {
  children: React.ReactNode;
  backgroundColor?: string;
}

export const ExplainerLayout: React.FC<ExplainerLayoutProps> = ({
  children,
  backgroundColor = VIDEO_COLORS.background,
}) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
