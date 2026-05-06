import React from "react";
import { Img, spring, useCurrentFrame, useVideoConfig, staticFile } from "remotion";

export type LogoVariant = "full" | "icon" | "wordmark";

export interface LogoProps {
  variant?: LogoVariant;
  delay?: number;
  size?: number;
  onDark?: boolean;
  style?: React.CSSProperties;
}

const logoFiles: Record<LogoVariant, string> = {
  full: "brand/logo-on-dark.svg",
  icon: "brand/logo-on-dark.svg",
  wordmark: "brand/logo-on-dark.svg",
};

const logoFilesLight: Record<LogoVariant, string> = {
  full: "brand/logo-on-light.svg",
  icon: "brand/logo-on-light.svg",
  wordmark: "brand/logo-on-light.svg",
};

export const Logo: React.FC<LogoProps> = ({
  variant = "full",
  delay = 0,
  size = 120,
  onDark = true,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 15, stiffness: 120 },
  });

  const files = onDark ? logoFiles : logoFilesLight;

  return (
    <Img
      src={staticFile(files[variant])}
      style={{
        height: size,
        width: "auto",
        opacity: progress,
        transform: `scale(${0.8 + progress * 0.2})`,
        ...style,
      }}
    />
  );
};
