/**
 * Callout — animated annotation overlay for screen recordings.
 *
 * Positioned absolutely over content. Spring-animated scale from 0 → 1 with label fade-in.
 * Three styles: circle (pulsing ring), arrow (pointing indicator), highlight (region box).
 */

import React from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { fontFamily } from "../../config/fonts";
import { BRAND } from "../../config/defaults";

export type CalloutStyle = "circle" | "arrow" | "highlight";

export interface CalloutProps {
  /** X position as percentage (0-100) */
  x: number;
  /** Y position as percentage (0-100) */
  y: number;
  /** Annotation label text */
  label: string;
  /** Visual style */
  calloutStyle?: CalloutStyle;
  /** Delay in frames before animation starts */
  delay?: number;
  /** Accent color */
  color?: string;
}

export const Callout: React.FC<CalloutProps> = ({
  x,
  y,
  label,
  calloutStyle = "circle",
  delay = 0,
  color = BRAND.primary,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scaleProgress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 12, stiffness: 200, mass: 0.5 },
  });

  const labelOpacity = interpolate(
    frame - delay,
    [8, 18],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  if (frame < delay) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) scale(${scaleProgress})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {/* Annotation shape */}
      {calloutStyle === "circle" && (
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            border: `3px solid ${color}`,
            backgroundColor: `${color}22`,
            boxShadow: `0 0 20px ${color}44`,
          }}
        />
      )}

      {calloutStyle === "arrow" && (
        <svg width={40} height={40} viewBox="0 0 40 40">
          <polygon
            points="20,5 35,30 5,30"
            fill={color}
            opacity={0.8}
          />
        </svg>
      )}

      {calloutStyle === "highlight" && (
        <div
          style={{
            width: 120,
            height: 60,
            borderRadius: 8,
            border: `2px solid ${color}`,
            backgroundColor: `${color}15`,
          }}
        />
      )}

      {/* Label */}
      <div
        style={{
          opacity: labelOpacity,
          fontFamily,
          fontSize: 18,
          fontWeight: 600,
          color: "#fff",
          backgroundColor: `${color}dd`,
          padding: "4px 12px",
          borderRadius: 6,
          whiteSpace: "nowrap",
          textShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      >
        {label}
      </div>
    </div>
  );
};
