/**
 * ScreenMockup — renders app screenshots/recordings with browser chrome
 * and timed annotation overlays.
 *
 * Two asset modes:
 * - Screenshot (PNG): Renders via ImageReveal with browser chrome frame
 * - Recording (MP4): Renders via VideoClip with browser chrome + annotations
 *
 * Device frames: browser (default), mobile, tablet, none
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import { ImageReveal } from "./ImageReveal";
import { VideoClip } from "./VideoClip";
import { Callout, type CalloutStyle } from "../annotations/Callout";
import { VIDEO_COLORS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";
import type { Annotation } from "./AnnotatedImage";

export interface ScreenMockupProps {
  /** Asset path (image or video). */
  src: string;
  /** Whether the asset is a video recording. */
  isRecording?: boolean;
  /** Annotations overlaid on the mockup. */
  annotations?: Annotation[];
  /** Indices of annotations currently revealed (driven by StoryboardRenderer). */
  revealedAnnotationIndices?: number[];
  /** Device frame style. */
  device?: "browser" | "mobile" | "tablet" | "none";
}

/** Browser chrome header with traffic lights and address bar. */
function BrowserChrome({ url }: { url?: string }) {
  return (
    <div
      style={{
        backgroundColor: "#1a1a2e",
        borderRadius: "12px 12px 0 0",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      {/* Traffic lights */}
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#ff5f57" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#febc2e" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#28c840" }} />
      </div>
      {/* Address bar */}
      <div
        style={{
          flex: 1,
          backgroundColor: "rgba(255,255,255,0.08)",
          borderRadius: 6,
          padding: "6px 12px",
          fontFamily,
          fontSize: 13,
          color: VIDEO_COLORS.mutedText,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {url ?? "app.royalti.io"}
      </div>
    </div>
  );
}

export const ScreenMockup: React.FC<ScreenMockupProps> = ({
  src,
  isRecording = false,
  annotations = [],
  revealedAnnotationIndices = [],
  device = "browser",
}) => {
  const showChrome = device === "browser";

  // device: "none" → full-bleed image, no chrome / padding / aspect-ratio constraints.
  // The schema explicitly opts out of the framed mockup; render the asset edge-to-edge
  // so portrait screenshots fill portrait compositions without letterboxing.
  if (device === "none") {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: VIDEO_COLORS.background,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {isRecording ? (
          <VideoClip src={src} />
        ) : (
          <ImageReveal src={src} effect="kenBurns" />
        )}
        {annotations.map((annotation, i) => {
          const isRevealed = revealedAnnotationIndices.includes(i);
          if (!isRevealed) return null;
          return (
            <Callout
              key={i}
              x={annotation.x}
              y={annotation.y}
              label={annotation.label}
              calloutStyle={(annotation.style ?? "circle") as CalloutStyle}
              color={annotation.color}
              delay={0}
            />
          );
        })}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        backgroundColor: VIDEO_COLORS.background,
      }}
    >
      <div
        style={{
          width: "90%",
          maxWidth: 1600,
          borderRadius: showChrome ? 12 : 8,
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          border: `1px solid ${VIDEO_COLORS.border}`,
          position: "relative",
        }}
      >
        {/* Browser chrome */}
        {showChrome && <BrowserChrome />}

        {/* Content area */}
        <div style={{ position: "relative", aspectRatio: "16/9" }}>
          {isRecording ? (
            <VideoClip src={src} />
          ) : (
            <ImageReveal src={src} effect="fade" />
          )}

          {/* Annotation overlays */}
          {annotations.map((annotation, i) => {
            const isRevealed = revealedAnnotationIndices.includes(i);
            if (!isRevealed) return null;

            return (
              <Callout
                key={i}
                x={annotation.x}
                y={annotation.y}
                label={annotation.label}
                calloutStyle={(annotation.style ?? "circle") as CalloutStyle}
                color={annotation.color}
                delay={0}
              />
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
