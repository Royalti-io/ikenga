/**
 * LogoIntro — animated brand intro using actual Royalti SVG logo.
 *
 * Pure Remotion composition — no AI-generated assets.
 * Features:
 * - Animated audio waveform background (React-generated SVG bars)
 * - Logo path draws in with stroke animation
 * - Brand name fades in below
 * - Teal glow pulse on reveal
 *
 * Duration: ~3 seconds (90 frames at 30fps)
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

/** Royalti logo SVG path (from public/brand/logo-on-dark.svg). */
const LOGO_PATH =
  "M235.21,0H94.76C42.43,0,0,42.43,0,94.76c0,.01,0,.02,0,.03v140.45C0,287.57,42.43,330,94.76,330h235.24V94.79C330,42.44,287.56,0,235.21,0ZM271.11,227.67c-10.64,18.41-25.93,33.7-44.35,44.32l-60.55-105.15v121.37c-67.07,0-121.43-54.37-121.43-121.43s54.37-121.43,121.43-121.43,121.43,54.37,121.43,121.43v.03h-121.59l105.06,60.85Z";

const WAVEFORM_BARS = 48;
const BAR_WIDTH = 6;
const BAR_GAP = 2;
const MAX_BAR_HEIGHT = 120;

interface LogoIntroProps {
  /** Duration in frames. Default: 90 (3s at 30fps). */
  durationInFrames?: number;
}

/** Generates a deterministic pseudo-random value for a given seed. */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Animated waveform bars behind the logo. */
function WaveformBackground() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const totalWidth = WAVEFORM_BARS * (BAR_WIDTH + BAR_GAP);
  const startX = (1920 - totalWidth) / 2;

  return (
    <AbsoluteFill style={{ opacity: 0.15 }}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080">
        {Array.from({ length: WAVEFORM_BARS }).map((_, i) => {
          // Each bar has a unique phase and amplitude
          const phase = seededRandom(i) * Math.PI * 2;
          const baseAmp = 0.3 + seededRandom(i + 100) * 0.7;

          // Animate: bars pulse with sine wave, staggered entry
          const entryDelay = i * 0.5; // frames
          const entryProgress = interpolate(
            frame,
            [entryDelay, entryDelay + 15],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          );

          const wave = Math.sin((frame / fps) * 3 + phase) * 0.3 + 0.7;
          const height = MAX_BAR_HEIGHT * baseAmp * wave * entryProgress;
          const x = startX + i * (BAR_WIDTH + BAR_GAP);
          const y = 540 - height / 2;

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={BAR_WIDTH}
              height={Math.max(2, height)}
              rx={BAR_WIDTH / 2}
              fill={BRAND.primary}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
}

export const LogoIntro: React.FC<LogoIntroProps> = ({
  durationInFrames = 90,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase 1: Logo scales up + fades in (frames 0-30)
  const logoProgress = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
    durationInFrames: 40,
  });

  const logoScale = interpolate(logoProgress, [0, 1], [0.6, 1]);
  const logoOpacity = interpolate(logoProgress, [0, 1], [0, 1]);

  // Phase 2: Glow pulse (frames 15-45)
  const glowProgress = interpolate(
    frame,
    [15, 30, 45],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Phase 3: Brand name slides up (frames 25-50)
  const textProgress = spring({
    frame: Math.max(0, frame - 25),
    fps,
    config: { damping: 15, stiffness: 100 },
  });

  const textY = interpolate(textProgress, [0, 1], [20, 0]);
  const textOpacity = interpolate(textProgress, [0, 1], [0, 1]);

  // Phase 4: Fade out at end
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: VIDEO_COLORS.background,
        opacity: fadeOut,
      }}
    >
      <WaveformBackground />

      {/* Logo + text container */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
        }}
      >
        {/* Logo SVG */}
        <div
          style={{
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
            filter: `drop-shadow(0 0 ${40 * glowProgress}px ${BRAND.primary})`,
          }}
        >
          <svg
            width={160}
            height={160}
            viewBox="0 0 330 330"
            fill="none"
          >
            <path d={LOGO_PATH} fill="white" />
          </svg>
        </div>

        {/* Brand name */}
        <div
          style={{
            opacity: textOpacity,
            transform: `translateY(${textY}px)`,
            fontFamily,
            fontSize: 48,
            fontWeight: 700,
            color: VIDEO_COLORS.text,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          ROYALTI
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
