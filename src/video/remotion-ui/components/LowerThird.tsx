import React from "react";
import { useCurrentFrame } from "remotion";
import { SlideIn } from "../core/SlideIn";
import { FadeIn } from "../core/FadeIn";
import { FadeOut } from "../core/FadeOut";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export interface LowerThirdProps {
  primary: string;
  secondary?: string;
  align?: "left" | "center" | "right";
  width?: number | string;
  startAt?: number;
  hideAfter?: number;
  logo?: React.ReactNode;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  primary,
  secondary,
  align = "left",
  width = "auto",
  startAt = 0,
  hideAfter,
  logo,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();

  if (frame < startAt) return null;
  if (hideAfter !== undefined && frame >= hideAfter) return null;

  const content = (
    <div
      style={{
        position: "absolute",
        bottom: 80,
        left: align === "right" ? undefined : 80,
        right: align === "left" ? undefined : 80,
        display: "flex",
        alignItems: "stretch",
        width,
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: 6,
          backgroundColor: theme.colors.primary,
          borderRadius: theme.radius.full,
          marginRight: theme.spacing[4],
          flexShrink: 0,
        }}
      />
      <div
        style={{
          backgroundColor: theme.colors.card,
          borderRadius: theme.radius.lg,
          padding: `${theme.spacing[4]}px ${theme.spacing[6]}px`,
          display: "flex",
          alignItems: "center",
          gap: theme.spacing[4],
          boxShadow: "0 4px 24px rgba(0, 0, 0, 0.4)",
        }}
      >
        {logo && <div style={{ flexShrink: 0 }}>{logo}</div>}
        <div style={{ textAlign: align }}>
          <div
            style={{
              fontFamily,
              fontSize: theme.typography.fontSize.lg,
              fontWeight: theme.typography.fontWeight.semibold,
              color: theme.colors.foreground,
            }}
          >
            {primary}
          </div>
          {secondary && (
            <div
              style={{
                fontFamily,
                fontSize: theme.typography.fontSize.sm,
                fontWeight: theme.typography.fontWeight.normal,
                color: theme.colors.mutedForeground,
                marginTop: 2,
              }}
            >
              {secondary}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (hideAfter !== undefined && frame >= hideAfter - 15) {
    return (
      <FadeOut startAt={hideAfter - 15} durationInFrames={15}>
        {content}
      </FadeOut>
    );
  }

  return (
    <SlideIn from="bottom" distance={40} startAt={startAt} durationInFrames={15}>
      <FadeIn startAt={startAt} durationInFrames={15}>
        {content}
      </FadeIn>
    </SlideIn>
  );
};
