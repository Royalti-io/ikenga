/**
 * Stat — a big numeric/short callout with a label.
 * Used for "20 min", "126 tools", "$1.2M" moments.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { fontFamily } from "@/video/config/fonts";

export type StatProps = {
  value: string | number;
  label: string;
  /** Override accent color (default: palette.highlight) */
  accent?: string;
  /** Small line above the value */
  subline?: string;
  /** Entrance frame relative to enclosing Sequence. Default: 0 */
  startAt?: number;
  size?: "sm" | "md" | "lg";
};

const VALUE_SIZE = { sm: 48, md: 72, lg: 96 } as const;
const LABEL_SIZE = { sm: 18, md: 22, lg: 28 } as const;
const SUBLINE_SIZE = { sm: 14, md: 18, lg: 22 } as const;

export const Stat: React.FC<StatProps> = ({
  value,
  label,
  accent,
  subline,
  startAt = 0,
  size = "md",
}) => {
  const palette = usePalette();
  const isLofi = palette.lofi === true;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const color = accent ?? palette.highlight;

  const p = spring({
    frame: frame - startAt,
    fps,
    config: { damping: 14, stiffness: 110, mass: 0.7 },
    from: 0,
    to: 1,
  });

  const opacity = interpolate(p, [0, 1], [0, 1]);
  const scale = interpolate(p, [0, 1], [0.8, 1.0]);

  const textShadow = isLofi ? "none" : `0 0 30px ${color}55`;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        opacity,
        transform: `scale(${scale})`,
        fontFamily,
      }}
    >
      {subline && (
        <div
          style={{
            fontSize: SUBLINE_SIZE[size],
            fontWeight: 500,
            color: palette.textSec,
            letterSpacing: "-0.01em",
          }}
        >
          {subline}
        </div>
      )}
      <div
        style={{
          fontSize: VALUE_SIZE[size],
          fontWeight: 700,
          color,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          textShadow,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: LABEL_SIZE[size],
          fontWeight: 500,
          color: palette.textSec,
          letterSpacing: "-0.01em",
        }}
      >
        {label}
      </div>
    </div>
  );
};
