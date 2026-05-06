import React from "react";
import { AbsoluteFill } from "remotion";
import { FadeIn } from "../../remotion-ui/core/FadeIn";
import { ScaleIn } from "../../remotion-ui/core/ScaleIn";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";
import { Logo } from "./Logo";

export interface EndScreenProps {
  headline: string;
  cta?: string;
  url?: string;
  showLogo?: boolean;
}

export const EndScreen: React.FC<EndScreenProps> = ({
  headline,
  cta = "Get Started",
  url = "royalti.io",
  showLogo = true,
}) => {
  const theme = useTheme();

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${theme.colors.background} 0%, ${theme.colors.gradientTo} 100%)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.spacing[8],
      }}
    >
      {showLogo && <Logo delay={5} size={80} />}

      <ScaleIn startAt={15} durationInFrames={20} initialScale={0.9}>
        <h2
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize["4xl"],
            fontWeight: theme.typography.fontWeight.bold,
            color: theme.colors.foreground,
            textAlign: "center",
            margin: 0,
            maxWidth: 900,
          }}
        >
          {headline}
        </h2>
      </ScaleIn>

      <FadeIn startAt={30} durationInFrames={15}>
        <div
          style={{
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radius.xl,
            padding: `${theme.spacing[4]}px ${theme.spacing[10]}px`,
          }}
        >
          <span
            style={{
              fontFamily,
              fontSize: theme.typography.fontSize.xl,
              fontWeight: theme.typography.fontWeight.semibold,
              color: theme.colors.primaryForeground,
            }}
          >
            {cta}
          </span>
        </div>
      </FadeIn>

      <FadeIn startAt={40} durationInFrames={15}>
        <span
          style={{
            fontFamily,
            fontSize: theme.typography.fontSize.lg,
            color: theme.colors.mutedForeground,
          }}
        >
          {url}
        </span>
      </FadeIn>
    </AbsoluteFill>
  );
};
