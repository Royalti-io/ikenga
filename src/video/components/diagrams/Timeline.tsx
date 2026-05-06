import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { useStaggeredReveal, useLineDrawSVG } from "../../hooks";
import { SPRING_CONFIGS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";

export interface TimelineEvent {
  date: string;
  label: string;
  description?: string;
}

export interface TimelineProps {
  events: TimelineEvent[];
  direction?: "horizontal" | "vertical";
  colorScheme?: { line: string; dot: string; text: string };
  delay?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  /** V3: Show only the first N events (progressive reveal). undefined = show all. */
  visibleCount?: number;
}

const DOT_R = 10;
const LINE_DRAW_FRAMES = 20;
const DOT_POP_FRAMES = 12;
const STAGGER = 15; // frames between events after line draws

export const Timeline = React.memo<TimelineProps>(({
  events,
  direction = "horizontal",
  colorScheme,
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  visibleCount,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const theme = useTheme();

  const canvasWidth = canvasWidthProp ?? width;
  const canvasHeight = canvasHeightProp ?? height;

  const lineColor = colorScheme?.line ?? theme.colors.border;
  const dotColor = colorScheme?.dot ?? theme.colors.primary;
  const textColor = colorScheme?.text ?? theme.colors.foreground;

  // V3: Progressive reveal — only show first N events, but keep layout stable
  const effectiveEvents = visibleCount != null ? events.slice(0, visibleCount) : events;
  const n = events.length; // Use FULL count for layout (prevents position shifts)
  const isH = direction === "horizontal";

  // Positions based on FULL events array (stable layout)
  const padding = isH ? 200 : 150;
  const positions = events.map((_, i) => {
    if (isH) {
      const span = canvasWidth - padding * 2;
      const x = padding + (n > 1 ? (i / (n - 1)) * span : span / 2);
      return { x, y: canvasHeight / 2 };
    } else {
      const span = canvasHeight - padding * 2;
      const y = padding + (n > 1 ? (i / (n - 1)) * span : span / 2);
      return { x: canvasWidth / 2, y };
    }
  });

  // Main line geometry — extends to last VISIBLE event (progressive reveal)
  const visibleN = effectiveEvents.length;
  const lineStart = positions[0];
  const lineEnd = visibleN > 0 ? positions[visibleN - 1] : lineStart;
  const totalLineLen = isH
    ? lineEnd.x - lineStart.x
    : lineEnd.y - lineStart.y;

  // Animation: line draws first, then dots stagger in
  const axisLine = useLineDrawSVG({
    totalLength: totalLineLen,
    delay,
    durationFrames: LINE_DRAW_FRAMES,
  });

  // Dots appear AFTER line is done
  const dotDelay = delay + LINE_DRAW_FRAMES;
  const dots = useStaggeredReveal({
    count: effectiveEvents.length,
    stagger: STAGGER,
    delay: dotDelay,
    springConfig: SPRING_CONFIGS.BOUNCY,
  });

  return (
    <svg
      width={canvasWidth}
      height={canvasHeight}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{ position: "absolute", inset: 0 }}
    >
      {/* Main axis line */}
      {totalLineLen > 0 && (
        <line
          x1={lineStart.x}
          y1={lineStart.y}
          x2={isH ? lineEnd.x : lineStart.x}
          y2={isH ? lineStart.y : lineEnd.y}
          stroke={lineColor}
          strokeWidth={3}
          strokeDasharray={axisLine.strokeDasharray}
          strokeDashoffset={axisLine.strokeDashoffset}
        />
      )}

      {/* Events */}
      {effectiveEvents.map((event, i) => {
        const pos = positions[i];
        const dotScale = dots.getItemProgress(i);

        // Text appears slightly after dot starts
        const textStart = dotDelay + i * STAGGER + DOT_POP_FRAMES / 2;
        const textOpacity = interpolate(
          frame - textStart,
          [0, 10],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

        return (
          <g key={i}>
            {/* Dot */}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={DOT_R * dotScale}
              fill={dotColor}
            />
            {/* Outer ring */}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={(DOT_R + 5) * dotScale}
              fill="none"
              stroke={dotColor}
              strokeWidth={2}
              opacity={dotScale * 0.4}
            />

            {isH ? (
              <>
                {/* Date above */}
                <text
                  x={pos.x}
                  y={pos.y - 35}
                  textAnchor="middle"
                  fill={theme.colors.mutedForeground}
                  fontFamily={fontFamily}
                  fontSize={16}
                  fontWeight={500}
                  opacity={textOpacity}
                >
                  {event.date}
                </text>
                {/* Label below */}
                <text
                  x={pos.x}
                  y={pos.y + 35}
                  textAnchor="middle"
                  fill={textColor}
                  fontFamily={fontFamily}
                  fontSize={20}
                  fontWeight={600}
                  opacity={textOpacity}
                >
                  {event.label}
                </text>
                {/* Description */}
                {event.description && (
                  <text
                    x={pos.x}
                    y={pos.y + 58}
                    textAnchor="middle"
                    fill={theme.colors.mutedForeground}
                    fontFamily={fontFamily}
                    fontSize={14}
                    opacity={textOpacity}
                  >
                    {event.description}
                  </text>
                )}
              </>
            ) : (
              <>
                {/* Date left */}
                <text
                  x={pos.x - 40}
                  y={pos.y - 5}
                  textAnchor="end"
                  fill={theme.colors.mutedForeground}
                  fontFamily={fontFamily}
                  fontSize={16}
                  fontWeight={500}
                  opacity={textOpacity}
                >
                  {event.date}
                </text>
                {/* Label right */}
                <text
                  x={pos.x + 40}
                  y={pos.y - 5}
                  textAnchor="start"
                  fill={textColor}
                  fontFamily={fontFamily}
                  fontSize={20}
                  fontWeight={600}
                  opacity={textOpacity}
                >
                  {event.label}
                </text>
                {event.description && (
                  <text
                    x={pos.x + 40}
                    y={pos.y + 18}
                    textAnchor="start"
                    fill={theme.colors.mutedForeground}
                    fontFamily={fontFamily}
                    fontSize={14}
                    opacity={textOpacity}
                  >
                    {event.description}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
});
