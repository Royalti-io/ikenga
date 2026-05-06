/**
 * Annotation — text label connected to a target point by an optional arrow.
 *
 * Line count (excluding imports + type def): ~80 lines.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { fontFamily } from "@/video/config/fonts";

// ── Types ──────────────────────────────────────────────────────────────────

export type AnnotationProps = {
  /** Target point in container coords. Set fraction:true for 0-1 normalised. */
  target: { x: number; y: number; fraction?: boolean };
  /** Position of the label relative to the target. */
  side: "top" | "bottom" | "left" | "right";
  /** Text content. */
  text: string;
  /** Arrow style. Default "curve". */
  arrow?: "curve" | "straight" | "none";
  /** Distance from target in px. Default 80. */
  distance?: number;
  /** Animation entrance frame. Default 0. */
  startAt?: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const OFFSETS: Record<"top" | "bottom" | "left" | "right", { dx: number; dy: number }> = {
  top:    { dx: 0,   dy: -1 },
  bottom: { dx: 0,   dy:  1 },
  left:   { dx: -1,  dy:  0 },
  right:  { dx:  1,  dy:  0 },
};

// ── Component ──────────────────────────────────────────────────────────────

export const Annotation: React.FC<AnnotationProps> = ({
  target,
  side,
  text,
  arrow = "curve",
  distance = 80,
  startAt = 0,
}) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const relFrame = frame - startAt;
  const opacity = interpolate(relFrame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const tx = target.fraction ? target.x * width  : target.x;
  const ty = target.fraction ? target.y * height : target.y;

  const { dx, dy } = OFFSETS[side];
  const lx = tx + dx * distance;
  const ly = ty + dy * distance;

  // Arrow path: label centre → target
  const pathD = arrow === "curve"
    ? `M ${lx} ${ly} Q ${(lx + tx) / 2} ${(ly + ty) / 2 - 30} ${tx} ${ty}`
    : `M ${lx} ${ly} L ${tx} ${ty}`;

  // Lofi: arrow appears immediately (no dash animation); hifi: drawn-on.
  const totalDash = 200;
  const dashProgress = palette.lofi
    ? 1
    : interpolate(relFrame, [0, 18], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const strokeDashoffset = totalDash * (1 - dashProgress);

  const shadow = palette.lofi ? "none" : "0 2px 8px rgba(0,0,0,0.3)";

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity }}>
      {/* Arrow SVG */}
      {arrow !== "none" && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
          <path
            d={pathD}
            fill="none"
            stroke={palette.accent}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={totalDash}
            strokeDashoffset={strokeDashoffset}
          />
          <circle cx={tx} cy={ty} r={4} fill={palette.accent} />
        </svg>
      )}
      {/* Label */}
      <div
        style={{
          position: "absolute",
          left: lx,
          top: ly,
          transform: "translate(-50%, -50%)",
          backgroundColor: palette.surface,
          border: `1px solid ${palette.border}`,
          borderRadius: 10,
          padding: "8px 16px",
          boxShadow: shadow,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontFamily, fontSize: 22, fontWeight: 600, color: palette.textPri }}>
          {text}
        </span>
      </div>
    </div>
  );
};
