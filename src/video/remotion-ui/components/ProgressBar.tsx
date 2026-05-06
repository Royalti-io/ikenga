import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing } from "../core/easing";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export interface ProgressBarProps {
  progress: number; // 0-1
  label?: string;
  startAt?: number;
  durationInFrames?: number;
  animated?: boolean;
  color?: string;
  height?: number;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  label,
  startAt = 0,
  durationInFrames = 30,
  animated = true,
  color,
  height = 16,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const barColor = color || theme.colors.primary;

  const currentProgress = animated
    ? interpolateWithEasing(
        frame,
        [startAt, startAt + durationInFrames],
        [0, progress],
        "ease-out-cubic",
      )
    : progress;

  return (
    <div style={{ width: "100%" }}>
      {label && (
        <div
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize.sm,
            color: theme.colors.mutedForeground,
            marginBottom: theme.spacing[2],
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{label}</span>
          <span>{Math.round(currentProgress * 100)}%</span>
        </div>
      )}
      <div
        style={{
          width: "100%",
          height,
          backgroundColor: theme.colors.muted,
          borderRadius: theme.radius.full,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${currentProgress * 100}%`,
            height: "100%",
            backgroundColor: barColor,
            borderRadius: theme.radius.full,
          }}
        />
      </div>
    </div>
  );
};
