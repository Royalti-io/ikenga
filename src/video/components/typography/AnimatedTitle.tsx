import React from "react";
import { useCurrentFrame, spring, interpolate, useVideoConfig } from "remotion";
import { FONT, VIDEO_COLORS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";
import type { SpringConfig } from "remotion";

export interface AnimatedTitleProps {
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  springConfig?: Partial<SpringConfig>;
  style?: React.CSSProperties;
}

export const AnimatedTitle: React.FC<AnimatedTitleProps> = ({
  text,
  delay = 0,
  fontSize = FONT.titleSize,
  color = VIDEO_COLORS.text,
  springConfig,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: {
      damping: 12,
      stiffness: 100,
      ...springConfig,
    },
  });

  const opacity = progress;
  const scale = interpolate(progress, [0, 1], [0.95, 1]);

  return (
    <h1
      style={{
        fontFamily,
        fontSize,
        fontWeight: 700,
        color,
        textAlign: "center",
        opacity,
        transform: `scale(${scale})`,
        ...style,
      }}
    >
      {text}
    </h1>
  );
};
