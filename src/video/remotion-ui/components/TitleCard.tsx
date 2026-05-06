import React from "react";
import { AbsoluteFill } from "remotion";
import { ScaleIn } from "../core/ScaleIn";
import { FadeIn } from "../core/FadeIn";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export interface TitleCardProps {
  title: string;
  subtitle?: string;
  startAt?: number;
  durationInFrames?: number;
  gradient?: boolean;
  logo?: React.ReactNode;
}

export const TitleCard: React.FC<TitleCardProps> = ({
  title,
  subtitle,
  startAt = 0,
  gradient = false,
  logo,
}) => {
  const theme = useTheme();

  const bgStyle: React.CSSProperties = gradient
    ? {
        background: `linear-gradient(135deg, ${theme.colors.gradientFrom}, ${theme.colors.gradientTo})`,
      }
    : { backgroundColor: theme.colors.background };

  return (
    <AbsoluteFill
      style={{
        ...bgStyle,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: theme.spacing[16],
      }}
    >
      {logo && (
        <FadeIn startAt={startAt} durationInFrames={15} style={{ marginBottom: theme.spacing[8] }}>
          {logo}
        </FadeIn>
      )}
      <ScaleIn
        startAt={startAt + (logo ? 10 : 0)}
        durationInFrames={20}
        initialScale={0.8}
        easing="ease-out-back"
      >
        <h1
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize["5xl"],
            fontWeight: theme.typography.fontWeight.bold,
            color: theme.colors.foreground,
            textAlign: "center",
            lineHeight: theme.typography.lineHeight.tight,
            margin: 0,
          }}
        >
          {title}
        </h1>
      </ScaleIn>
      {subtitle && (
        <FadeIn startAt={startAt + 15} durationInFrames={20}>
          <p
            style={{
              fontFamily,
              fontSize: theme.typography.fontSize.xl,
              fontWeight: theme.typography.fontWeight.normal,
              color: theme.colors.mutedForeground,
              textAlign: "center",
              marginTop: theme.spacing[4],
            }}
          >
            {subtitle}
          </p>
        </FadeIn>
      )}
    </AbsoluteFill>
  );
};
