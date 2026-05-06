import React from "react";
import { ScaleIn } from "../core/ScaleIn";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export interface StatBlockProps {
  value: string;
  label: string;
  delta?: {
    value: string;
    direction: "up" | "down";
  };
  startAt?: number;
  durationInFrames?: number;
}

export const StatBlock: React.FC<StatBlockProps> = ({
  value,
  label,
  delta,
  startAt = 0,
}) => {
  const theme = useTheme();

  const deltaColor =
    delta?.direction === "up" ? theme.colors.success : theme.colors.destructive;
  const deltaArrow = delta?.direction === "up" ? "\u2191" : "\u2193";

  return (
    <ScaleIn startAt={startAt} durationInFrames={15} initialScale={0.8} easing="ease-out-back">
      <div
        style={{
          backgroundColor: theme.colors.card,
          borderRadius: theme.radius.lg,
          padding: `${theme.spacing[6]}px ${theme.spacing[8]}px`,
          border: `1px solid ${theme.colors.border}`,
          textAlign: "center",
          minWidth: 200,
        }}
      >
        <div
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize["3xl"],
            fontWeight: theme.typography.fontWeight.bold,
            color: theme.colors.foreground,
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize.sm,
            color: theme.colors.mutedForeground,
            marginTop: theme.spacing[1],
          }}
        >
          {label}
        </div>
        {delta && (
          <div
            style={{
              fontFamily,
              fontSize: theme.typography.fontSize.sm,
              fontWeight: theme.typography.fontWeight.medium,
              color: deltaColor,
              marginTop: theme.spacing[2],
            }}
          >
            {deltaArrow} {delta.value}
          </div>
        )}
      </div>
    </ScaleIn>
  );
};
