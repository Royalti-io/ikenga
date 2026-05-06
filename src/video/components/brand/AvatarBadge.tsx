/**
 * AvatarBadge — circular gradient badge with a centered glyph.
 *
 * Used standalone or as the `accent_glyph` field on a `text_overlay` visual.
 * Springs in (scale 0 → 1 + opacity) and optionally emits a soft glow.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { fontFamily } from "../../config/fonts";
import { BRAND } from "../../config/defaults";

export interface AvatarBadgeProps {
  /** Single character or emoji rendered inside the badge. */
  glyph: string;
  /** Solid color OR [from, to] radial gradient ramp. */
  color?: string | [string, string];
  /** Diameter in px. Default 180. */
  size?: number;
  /** Add a soft glow ring. Default true. */
  glow?: boolean;
  /** Frame to start the entry animation. Default 0. */
  startAt?: number;
  style?: React.CSSProperties;
}

/** Resolve `color` prop into a CSS background string + a "ring" color for glow. */
function resolveBackground(color: AvatarBadgeProps["color"]): {
  background: string;
  glowColor: string;
} {
  if (Array.isArray(color)) {
    const [from, to] = color;
    return {
      background: `radial-gradient(circle at 30% 30%, ${from} 0%, ${to} 100%)`,
      glowColor: to,
    };
  }
  if (typeof color === "string") {
    return { background: color, glowColor: color };
  }
  // Default: brand teal radial gradient
  const from = BRAND.gradientFrom ?? BRAND.primary;
  const to = BRAND.gradientTo ?? BRAND.primary;
  return {
    background: `radial-gradient(circle at 30% 30%, ${from} 0%, ${to} 100%)`,
    glowColor: BRAND.primary,
  };
}

export const AvatarBadge: React.FC<AvatarBadgeProps> = ({
  glyph,
  color,
  size = 180,
  glow = true,
  startAt = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { background, glowColor } = resolveBackground(color);

  const progress = spring({
    frame: frame - startAt,
    fps,
    config: { damping: 12, stiffness: 160 },
  });
  const scale = interpolate(progress, [0, 1], [0, 1]);
  const opacity = progress;

  const glowSize = Math.round(size * 0.35);
  const boxShadow = glow ? `0 0 ${glowSize}px ${glowColor}` : undefined;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background,
        boxShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center",
        ...style,
      }}
    >
      <span
        style={{
          fontFamily,
          fontWeight: 800,
          color: "#FFFFFF",
          fontSize: Math.round(size * 0.45),
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        {glyph}
      </span>
    </div>
  );
};
