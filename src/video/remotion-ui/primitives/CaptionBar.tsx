/**
 * CaptionBar — bottom-anchored caption pill, synced to ABSOLUTE video frame.
 *
 * @warning PLACEMENT: This component calls `useCurrentFrame()` directly
 * (not Sequence-relative). It MUST be placed at the ROOT of the composition
 * (outside of any `<Sequence>`), otherwise its frame counter resets and
 * caption sync breaks. The CaptionBar in AskRoyClipVideo demonstrates the
 * correct placement — rendered as a sibling of Sequence elements, not inside them.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { fontFamily } from "@/video/config/fonts";

// ── Types ──────────────────────────────────────────────────────────────────

export type CaptionPhrase = {
  text: string;
  /** Seconds, absolute from video start. */
  start: number;
  /** Seconds, absolute from video start. */
  end: number;
};

export type CaptionBarProps = {
  phrases: CaptionPhrase[];
  /** Distance from anchor edge in px. Default 260. */
  inset?: number;
  /** Anchor side. Default "bottom". */
  position?: "bottom" | "top";
  /** Max content width (fraction of container). Default 0.84. */
  maxWidth?: number;
  /** Font size override. Default 44. */
  fontSize?: number;
};

// ── Component ──────────────────────────────────────────────────────────────

export const CaptionBar: React.FC<CaptionBarProps> = ({
  phrases,
  inset = 260,
  position = "bottom",
  maxWidth = 0.84,
  fontSize = 44,
}) => {
  const palette = usePalette();
  // useCurrentFrame() is called here — absolute video frame, NOT Sequence-relative.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentSec = frame / fps;
  const active = phrases.find((p) => currentSec >= p.start && currentSec < p.end);

  if (!active) return null;

  const accentBg = palette.lofi
    ? palette.surface
    : `${palette.accent}E0`; // 88% alpha hex

  const border = palette.lofi
    ? `1px solid ${palette.border}`
    : `1px solid ${palette.accent}`;

  const shadow = palette.lofi ? "none" : "0 6px 24px rgba(0,0,0,0.35)";

  const anchorStyle = position === "bottom"
    ? { justifyContent: "flex-end", paddingBottom: inset }
    : { justifyContent: "flex-start", paddingTop: inset };

  return (
    <AbsoluteFill
      style={{
        ...anchorStyle,
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          backgroundColor: accentBg,
          border,
          borderRadius: 14,
          padding: "14px 28px",
          maxWidth: `${maxWidth * 100}%`,
          textAlign: "center",
          boxShadow: shadow,
        }}
      >
        <span
          style={{
            fontFamily,
            fontSize,
            fontWeight: 600,
            color: palette.textPri,
            lineHeight: 1.25,
            letterSpacing: "-0.01em",
          }}
        >
          {active.text}
        </span>
      </div>
    </AbsoluteFill>
  );
};
