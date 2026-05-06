/**
 * SubtitleOverlay — word-by-word highlighted subtitles.
 *
 * Shows the current sentence at the bottom of the screen with
 * the active word highlighted in brand primary color + slight scale.
 *
 * Style: Full current sentence visible, word-by-word karaoke highlight.
 * Position: Bottom 15% of screen, centered, semi-transparent dark bar.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { TikTokPage } from "@remotion/captions";
import { fontFamily } from "../../config/fonts";
import { BRAND, VIDEO_COLORS } from "../../config/defaults";

export interface SubtitleOverlayProps {
  /** Paginated caption pages from toCaptionPages(). */
  pages: TikTokPage[];
  /** Start frame of this beat within the parent scene (section-relative). */
  beatStartFrameInScene: number;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  pages,
  beatStartFrameInScene,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // frame is beat-relative (from TransitionSeries). Add beat's position
  // within scene to get section-relative time. Caption pages are 0-indexed
  // from section voiceover start, matching this coordinate system.
  const sectionRelativeFrame = beatStartFrameInScene + frame;
  const currentMs = (sectionRelativeFrame / fps) * 1000;

  // Find the active page
  const activePage = pages.find((page) => {
    const pageEndMs = page.startMs + page.durationMs;
    return currentMs >= page.startMs && currentMs < pageEndMs;
  });

  if (!activePage) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 80,
        pointerEvents: "none",
      }}
    >
      {/* Semi-transparent background bar */}
      <div
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.7)",
          borderRadius: 12,
          padding: "16px 32px",
          maxWidth: "80%",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.3em",
          justifyContent: "center",
          lineHeight: 1.5,
        }}
      >
        {activePage.tokens.map((token, i) => {
          const isActive = currentMs >= token.fromMs && currentMs < token.toMs;
          const isPast = currentMs >= token.toMs;

          return (
            <span
              key={i}
              style={{
                fontFamily,
                fontSize: 36,
                fontWeight: isActive ? 800 : 600,
                color: isActive
                  ? BRAND.primary
                  : isPast
                    ? VIDEO_COLORS.text
                    : "rgba(248, 250, 252, 0.6)",
                transform: isActive ? "scale(1.1)" : "scale(1)",
                display: "inline-block",
                transition: "none", // No CSS transitions in Remotion — frame-based only
              }}
            >
              {token.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
