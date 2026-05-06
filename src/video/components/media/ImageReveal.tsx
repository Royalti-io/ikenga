/**
 * ImageReveal — renders images with cinematic reveal effects.
 *
 * V2 effects added:
 * - parallax: slow background shift (creates depth)
 * - splitReveal: image splits from center
 * - glitch: brief digital glitch on entry
 * - maskReveal: circular mask wipe reveal
 */

import React from "react";
import { useCurrentFrame, Img, staticFile, interpolate } from "remotion";
import { interpolateWithEasing } from "../../remotion-ui/core/easing";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export type ImageEffect =
  | "fade"
  | "zoomIn"
  | "zoomOut"
  | "panLeft"
  | "panRight"
  | "kenBurns"
  | "parallax"
  | "splitReveal"
  | "glitch"
  | "maskReveal";

export interface ImageRevealProps {
  src: string;
  effect?: ImageEffect;
  startAt?: number;
  durationInFrames?: number;
  style?: React.CSSProperties;
}

const Placeholder: React.FC = () => {
  const theme = useTheme();
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: theme.colors.muted,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{
          fontFamily,
          fontSize: 24,
          color: theme.colors.mutedForeground,
        }}
      >
        Asset not found
      </span>
    </div>
  );
};

export const ImageReveal: React.FC<ImageRevealProps> = ({
  src,
  effect = "fade",
  startAt = 0,
  durationInFrames = 60,
  style,
}) => {
  const frame = useCurrentFrame();

  const progress = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, 1],
    "ease-out",
  );

  const resolvedSrc = src.startsWith("http") ? src : staticFile(src);

  // ── Effect: splitReveal ──────────────────────────────────────────────
  if (effect === "splitReveal") {
    const revealProgress = interpolateWithEasing(
      frame,
      [startAt, startAt + 20],
      [0, 1],
      "ease-out",
    );
    const splitOffset = interpolate(revealProgress, [0, 1], [50, 0]);

    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", ...style }}>
        <ErrorBoundary fallback={<Placeholder />}>
          {/* Left half */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "50%",
              height: "100%",
              overflow: "hidden",
              transform: `translateX(-${splitOffset}%)`,
            }}
          >
            <Img
              src={resolvedSrc}
              style={{
                width: "200%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
          {/* Right half */}
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              width: "50%",
              height: "100%",
              overflow: "hidden",
              transform: `translateX(${splitOffset}%)`,
            }}
          >
            <Img
              src={resolvedSrc}
              style={{
                width: "200%",
                height: "100%",
                objectFit: "cover",
                marginLeft: "-100%",
              }}
            />
          </div>
        </ErrorBoundary>
      </div>
    );
  }

  // ── Effect: maskReveal ───────────────────────────────────────────────
  if (effect === "maskReveal") {
    const revealProgress = interpolateWithEasing(
      frame,
      [startAt, startAt + 25],
      [0, 1],
      "ease-out",
    );
    // Circular mask from center, expanding
    const radius = revealProgress * 150; // percentage-based

    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", ...style }}>
        <ErrorBoundary fallback={<Placeholder />}>
          <Img
            src={resolvedSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              clipPath: `circle(${radius}% at 50% 50%)`,
            }}
          />
        </ErrorBoundary>
      </div>
    );
  }

  // ── Effect: glitch ───────────────────────────────────────────────────
  if (effect === "glitch") {
    const entryFrames = 8;
    const isGlitching = frame >= startAt && frame < startAt + entryFrames;

    const glitchOffsetX = isGlitching
      ? Math.sin(frame * 47) * 8
      : 0;
    const glitchOffsetY = isGlitching
      ? Math.cos(frame * 31) * 4
      : 0;
    const glitchOpacity = frame >= startAt
      ? interpolate(frame, [startAt, startAt + entryFrames], [0.7, 1], {
          extrapolateRight: "clamp",
        })
      : 0;

    // RGB split effect during glitch
    const rgbOffset = isGlitching ? 3 : 0;

    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", ...style }}>
        <ErrorBoundary fallback={<Placeholder />}>
          {/* Red channel offset */}
          {isGlitching && (
            <Img
              src={resolvedSrc}
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                transform: `translate(${rgbOffset}px, 0)`,
                filter: "saturate(0) brightness(1.2)",
                mixBlendMode: "screen",
                opacity: 0.3,
              }}
            />
          )}
          {/* Main image */}
          <Img
            src={resolvedSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: glitchOpacity,
              transform: `translate(${glitchOffsetX}px, ${glitchOffsetY}px)`,
            }}
          />
        </ErrorBoundary>
      </div>
    );
  }

  // ── Standard effects ─────────────────────────────────────────────────
  const getTransform = (): string => {
    switch (effect) {
      case "zoomIn":
        return `scale(${1 + progress * 0.35})`;
      case "zoomOut":
        return `scale(${1.35 - progress * 0.35})`;
      case "panLeft":
        return `scale(1.15) translateX(${8 - progress * 16}%)`;
      case "panRight":
        return `scale(1.15) translateX(${-8 + progress * 16}%)`;
      case "kenBurns":
        return `scale(${1.05 + progress * 0.2}) translateX(${-3 + progress * 6}%)`;
      case "parallax":
        return `scale(1.15) translateY(${-5 + progress * 10}%)`;
      default:
        return "none";
    }
  };

  const opacity =
    effect === "fade"
      ? interpolateWithEasing(frame, [startAt, startAt + 15], [0, 1], "ease-out")
      : effect === "parallax"
        ? interpolateWithEasing(frame, [startAt, startAt + 10], [0, 1], "ease-out")
        : 1;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        ...style,
      }}
    >
      <ErrorBoundary fallback={<Placeholder />}>
        <Img
          src={resolvedSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity,
            transform: getTransform(),
          }}
        />
      </ErrorBoundary>
    </div>
  );
};

// Simple error boundary for graceful fallback on missing assets
class ErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
