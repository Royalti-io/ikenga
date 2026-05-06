/**
 * AvatarBadge — circular badge for persona reveals ("Meet Roy").
 *
 * Replaces hand-coded radial-gradient circles in AskRoyClipVideo.
 * Phase 3 will migrate AskRoy to use this primitive.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { fontFamily } from "@/video/config/fonts";

// ── Types ──────────────────────────────────────────────────────────────────

export type AvatarBadgeProps = {
  /** Single character, short string, or React node. */
  glyph: string | React.ReactNode;
  /** Diameter in px. Default 160. */
  size?: number;
  /** Glow halo. Default true (auto-disabled in lofi). */
  glow?: boolean;
  /** Border around the badge. Default true. */
  bordered?: boolean;
  /** Background style. Default "gradient". */
  background?: "solid" | "gradient" | "surface";
  /** Animation entrance frame. Default 0. */
  startAt?: number;
};

// ── Component ──────────────────────────────────────────────────────────────

export const AvatarBadge: React.FC<AvatarBadgeProps> = ({
  glyph,
  size = 160,
  glow = true,
  bordered = true,
  background = "gradient",
  startAt = 0,
}) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const relFrame = frame - startAt;
  const p = spring({ frame: relFrame, fps, config: { damping: 14, stiffness: 110, mass: 0.7 } });

  const opacity = Math.min(p, 1);
  const scale = 0.8 + p * 0.2;

  // Background — lofi always collapses to surface
  let bg: string;
  if (palette.lofi) {
    bg = palette.surface;
  } else if (background === "gradient") {
    bg = `radial-gradient(circle at 30% 30%, ${palette.accent}, ${palette.bg} 85%)`;
  } else if (background === "solid") {
    bg = palette.accent;
  } else {
    bg = palette.surface;
  }

  const glyphColor = palette.lofi ? palette.textPri : palette.highlight;
  const glyphSize = size * 0.45;

  const border = bordered
    ? palette.lofi
      ? `1px solid ${palette.border}`
      : `3px solid ${palette.highlight}`
    : "none";

  const boxShadow =
    glow && !palette.lofi ? `0 0 60px ${palette.accent}66` : "none";

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: bg,
        border,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow,
        opacity,
        transform: `scale(${scale})`,
        fontFamily,
        fontSize: glyphSize,
        fontWeight: 700,
        color: glyphColor,
        flexShrink: 0,
      }}
    >
      {glyph}
    </div>
  );
};
