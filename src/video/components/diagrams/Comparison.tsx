import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { useProgressBar } from "../../hooks";
import { fontFamily } from "../../config/fonts";

export interface ComparisonSide {
  title: string;
  items: string[];
  color?: string;
}

export interface ComparisonProps {
  left: ComparisonSide;
  right: ComparisonSide;
  vsLabel?: string;
  delay?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  /** V3: Which side(s) to reveal. undefined = show both (default behavior). */
  revealedSide?: "none" | "left" | "right" | "both";
}

const HEADER_ANIM = 15;
const VS_ANIM = 10;
const ITEM_STAGGER = 6;

export const Comparison = React.memo<ComparisonProps>(({
  left,
  right,
  vsLabel = "VS",
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  revealedSide,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const theme = useTheme();

  const canvasWidth = canvasWidthProp ?? width;
  const canvasHeight = canvasHeightProp ?? height;

  const leftColor = left.color ?? theme.colors.success;
  const rightColor = right.color ?? theme.colors.destructive;

  // V3: Progressive reveal — control side visibility
  const showLeft = revealedSide == null || revealedSide === "left" || revealedSide === "both";
  const showRight = revealedSide == null || revealedSide === "right" || revealedSide === "both";

  const colWidth = (canvasWidth - 200) / 2;
  const leftX = 80;
  const rightX = canvasWidth - 80 - colWidth;
  const headerY = 180;
  const itemStartY = 280;
  const itemGap = 60;

  // Header animations: slide from edges
  const leftHeader = useProgressBar({
    delay,
    springConfig: { damping: 15, stiffness: 100 },
  });
  const rightHeader = useProgressBar({
    delay: delay + 5,
    springConfig: { damping: 15, stiffness: 100 },
  });

  // VS badge pop-in
  const vsStart = delay + HEADER_ANIM;
  const vsBadge = useProgressBar({
    delay: vsStart,
    springConfig: { damping: 8, stiffness: 150, mass: 0.5 },
  });

  // Items stagger — alternating left/right
  const maxItems = Math.max(left.items.length, right.items.length);
  const itemsStart = vsStart + VS_ANIM;

  return (
    <svg
      width={canvasWidth}
      height={canvasHeight}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{ position: "absolute", inset: 0 }}
    >
      {/* Left header */}
      <g
        style={{
          opacity: showLeft ? leftHeader.opacity : 0,
          transform: `translateX(${-40 * (1 - leftHeader.progress)}px)`,
        }}
      >
        <rect
          x={leftX}
          y={headerY - 30}
          width={colWidth}
          height={60}
          rx={12}
          fill={leftColor}
          opacity={0.15}
        />
        <line
          x1={leftX}
          y1={headerY - 30}
          x2={leftX}
          y2={headerY + 30}
          stroke={leftColor}
          strokeWidth={4}
        />
        <text
          x={leftX + 24}
          y={headerY}
          dominantBaseline="central"
          fill={leftColor}
          fontFamily={fontFamily}
          fontSize={28}
          fontWeight={700}
        >
          {left.title}
        </text>
      </g>

      {/* Right header */}
      <g
        style={{
          opacity: showRight ? rightHeader.opacity : 0,
          transform: `translateX(${40 * (1 - rightHeader.progress)}px)`,
        }}
      >
        <rect
          x={rightX}
          y={headerY - 30}
          width={colWidth}
          height={60}
          rx={12}
          fill={rightColor}
          opacity={0.15}
        />
        <line
          x1={rightX + colWidth}
          y1={headerY - 30}
          x2={rightX + colWidth}
          y2={headerY + 30}
          stroke={rightColor}
          strokeWidth={4}
        />
        <text
          x={rightX + colWidth - 24}
          y={headerY}
          dominantBaseline="central"
          textAnchor="end"
          fill={rightColor}
          fontFamily={fontFamily}
          fontSize={28}
          fontWeight={700}
        >
          {right.title}
        </text>
      </g>

      {/* VS badge */}
      <g
        style={{
          opacity: vsBadge.opacity,
          transform: `scale(${vsBadge.progress})`,
          transformOrigin: `${canvasWidth / 2}px ${headerY}px`,
        }}
      >
        <circle
          cx={canvasWidth / 2}
          cy={headerY}
          r={32}
          fill={theme.colors.card}
          stroke={theme.colors.border}
          strokeWidth={2}
        />
        <text
          x={canvasWidth / 2}
          y={headerY}
          textAnchor="middle"
          dominantBaseline="central"
          fill={theme.colors.foreground}
          fontFamily={fontFamily}
          fontSize={18}
          fontWeight={800}
        >
          {vsLabel}
        </text>
      </g>

      {/* Items — alternating left/right */}
      {Array.from({ length: maxItems }).map((_, i) => {
        const leftItem = left.items[i];
        const rightItem = right.items[i];
        const y = itemStartY + i * itemGap;

        // Left items appear on even indices, right on odd (alternating reveal)
        const leftItemStart = itemsStart + i * ITEM_STAGGER;
        const rightItemStart = itemsStart + i * ITEM_STAGGER + 3;

        const leftOpacity = leftItem && showLeft
          ? interpolate(frame - leftItemStart, [0, 8], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 0;
        const rightOpacity = rightItem && showRight
          ? interpolate(frame - rightItemStart, [0, 8], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 0;

        return (
          <g key={i}>
            {/* Left item */}
            {leftItem && (
              <g opacity={leftOpacity}>
                {/* Checkmark */}
                <circle cx={leftX + 14} cy={y} r={12} fill={leftColor} opacity={0.2} />
                <text
                  x={leftX + 14}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={leftColor}
                  fontSize={16}
                  fontWeight={700}
                >
                  ✓
                </text>
                <text
                  x={leftX + 36}
                  y={y}
                  dominantBaseline="central"
                  fill={theme.colors.foreground}
                  fontFamily={fontFamily}
                  fontSize={20}
                >
                  {leftItem}
                </text>
              </g>
            )}

            {/* Right item */}
            {rightItem && (
              <g opacity={rightOpacity}>
                <circle cx={rightX + 14} cy={y} r={12} fill={rightColor} opacity={0.2} />
                <text
                  x={rightX + 14}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={rightColor}
                  fontSize={16}
                  fontWeight={700}
                >
                  ✗
                </text>
                <text
                  x={rightX + 36}
                  y={y}
                  dominantBaseline="central"
                  fill={theme.colors.foreground}
                  fontFamily={fontFamily}
                  fontSize={20}
                >
                  {rightItem}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
});
