/**
 * LogoOutro — animated brand outro with CTA.
 *
 * Pure Remotion composition — no AI-generated assets.
 * Features:
 * - Fading waveform background
 * - Logo fades in from center
 * - CTA headline + button-styled text
 * - URL text at bottom
 *
 * Duration: ~4 seconds (120 frames at 30fps)
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { VIDEO_COLORS, BRAND } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";

const LOGO_PATH =
  "M235.21,0H94.76C42.43,0,0,42.43,0,94.76c0,.01,0,.02,0,.03v140.45C0,287.57,42.43,330,94.76,330h235.24V94.79C330,42.44,287.56,0,235.21,0ZM271.11,227.67c-10.64,18.41-25.93,33.7-44.35,44.32l-60.55-105.15v121.37c-67.07,0-121.43-54.37-121.43-121.43s54.37-121.43,121.43-121.43,121.43,54.37,121.43,121.43v.03h-121.59l105.06,60.85Z";

interface LogoOutroProps {
  /** Duration in frames. Default: 120 (4s at 30fps). */
  durationInFrames?: number;
  /** CTA headline text. */
  headline?: string;
  /** CTA button text. */
  ctaText?: string;
  /** URL to display. */
  url?: string;
}

/** Subtle animated waveform bars (quieter than intro). */
function SubtleWaveform() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const barCount = 32;
  const barWidth = 4;
  const barGap = 4;
  const maxHeight = 60;
  const totalWidth = barCount * (barWidth + barGap);
  const startX = (1920 - totalWidth) / 2;

  return (
    <AbsoluteFill style={{ opacity: 0.08 }}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080">
        {Array.from({ length: barCount }).map((_, i) => {
          const phase = Math.sin(i * 0.7) * Math.PI;
          const baseAmp = 0.4 + Math.abs(Math.sin(i * 0.3)) * 0.6;
          const wave = Math.sin((frame / fps) * 2 + phase) * 0.3 + 0.7;
          const height = maxHeight * baseAmp * wave;
          const x = startX + i * (barWidth + barGap);
          const y = 540 - height / 2;

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(2, height)}
              rx={barWidth / 2}
              fill={BRAND.primary}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
}

export const LogoOutro: React.FC<LogoOutroProps> = ({
  headline = "Stop Decoding Statements Manually",
  ctaText = "Try Royalti Free — 14 Days",
  url = "royalti.io",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase 1: Fade in from black (frames 0-15)
  const fadeIn = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Phase 2: Logo appears (frames 5-30)
  const logoProgress = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: { damping: 14, stiffness: 90 },
  });

  // Phase 3: Headline slides in (frames 20-45)
  const headlineProgress = spring({
    frame: Math.max(0, frame - 20),
    fps,
    config: { damping: 15, stiffness: 100 },
  });
  const headlineY = interpolate(headlineProgress, [0, 1], [30, 0]);

  // Phase 4: CTA button appears (frames 35-55)
  const ctaProgress = spring({
    frame: Math.max(0, frame - 35),
    fps,
    config: { damping: 12, stiffness: 120 },
  });
  const ctaScale = interpolate(ctaProgress, [0, 1], [0.8, 1]);

  // Phase 5: URL fades in (frames 45-60)
  const urlOpacity = interpolate(frame, [45, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // CTA button glow pulse (continuous after appearance)
  const glowPhase = Math.max(0, frame - 55);
  const glowIntensity = Math.sin(glowPhase / fps * 2) * 0.3 + 0.7;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: VIDEO_COLORS.background,
        opacity: fadeIn,
      }}
    >
      <SubtleWaveform />

      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 32,
        }}
      >
        {/* Logo */}
        <div
          style={{
            opacity: logoProgress,
            transform: `scale(${interpolate(logoProgress, [0, 1], [0.7, 1])})`,
          }}
        >
          <svg width={100} height={100} viewBox="0 0 330 330" fill="none">
            <path d={LOGO_PATH} fill="white" />
          </svg>
        </div>

        {/* Headline */}
        <div
          style={{
            opacity: headlineProgress,
            transform: `translateY(${headlineY}px)`,
            fontFamily,
            fontSize: 52,
            fontWeight: 700,
            color: VIDEO_COLORS.text,
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.2,
          }}
        >
          {headline}
        </div>

        {/* CTA Button */}
        <div
          style={{
            opacity: ctaProgress,
            transform: `scale(${ctaScale})`,
            backgroundColor: BRAND.primary,
            borderRadius: 12,
            padding: "18px 48px",
            boxShadow: `0 0 ${30 * glowIntensity}px ${BRAND.primary}80`,
          }}
        >
          <div
            style={{
              fontFamily,
              fontSize: 28,
              fontWeight: 700,
              color: "white",
              letterSpacing: 1,
            }}
          >
            {ctaText}
          </div>
        </div>

        {/* URL */}
        <div
          style={{
            opacity: urlOpacity,
            fontFamily,
            fontSize: 22,
            fontWeight: 500,
            color: VIDEO_COLORS.mutedText,
            letterSpacing: 2,
          }}
        >
          {url}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
