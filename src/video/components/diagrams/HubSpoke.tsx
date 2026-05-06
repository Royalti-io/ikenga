import React, { useMemo } from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { useProgressBar, useStaggeredReveal } from "../../hooks";
import { SPRING_CONFIGS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";

export interface HubSpokeNode {
  label: string;
  icon?: string;
}

export interface HubSpokeProps {
  center: HubSpokeNode;
  spokes: HubSpokeNode[];
  colorScheme?: { hub: string; spoke: string; line: string };
  delay?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  /** Index of spoke to highlight with a pulse glow. -1 or undefined = no highlight. */
  highlightIndex?: number;
  /** Frame at which the highlight pulse starts. */
  highlightAt?: number;
  /** V3: Show only the first N spokes (progressive reveal). undefined = show all. */
  visibleSpokeCount?: number;
}

const HUB_R = 60;
const SPOKE_R = 40;
const LINE_DRAW = 12;
const SPOKE_STAGGER = 8;

export const HubSpoke = React.memo<HubSpokeProps>(({
  center,
  spokes,
  colorScheme,
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  highlightIndex = -1,
  highlightAt = 60,
  visibleSpokeCount,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const theme = useTheme();

  const canvasWidth = canvasWidthProp ?? width;
  const canvasHeight = canvasHeightProp ?? height;

  const hubColor = colorScheme?.hub ?? theme.colors.primary;
  const spokeColor = colorScheme?.spoke ?? theme.colors.card;
  const lineColor = colorScheme?.line ?? theme.colors.border;

  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  // V3: Progressive reveal — only show first N spokes
  const effectiveSpokes = visibleSpokeCount != null ? spokes.slice(0, visibleSpokeCount) : spokes;
  // Use full spokes count for position calculation (keeps layout stable as spokes appear)
  const n = spokes.length;

  // Orbit radius scales with spoke count and canvas size
  const minDim = Math.min(canvasWidth, canvasHeight);
  const orbitR = Math.min(minDim * 0.32, 320);

  // Pre-calculated spoke positions
  const spokePositions = useMemo(() =>
    spokes.map((_, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2; // start from top
      return {
        x: cx + orbitR * Math.cos(angle),
        y: cy + orbitR * Math.sin(angle),
      };
    }),
    [n, cx, cy, orbitR]
  );

  // Hub entrance
  const hubStart = delay;
  const spokesStart = hubStart + 15;
  const hub = useProgressBar({
    delay: hubStart,
    springConfig: { damping: 12, stiffness: 100 },
  });

  // Spoke nodes (appear after line draws)
  const spokeNodes = useStaggeredReveal({
    count: effectiveSpokes.length,
    stagger: SPOKE_STAGGER,
    delay: spokesStart + LINE_DRAW, // spokes appear after their line draws
    springConfig: SPRING_CONFIGS.BOUNCY,
  });

  return (
    <svg
      width={canvasWidth}
      height={canvasHeight}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{ position: "absolute", inset: 0 }}
    >
      {/* Connection lines (drawn behind nodes) — only for visible spokes */}
      {spokePositions.map((pos, i) => {
        if (visibleSpokeCount != null && i >= visibleSpokeCount) return null;
        const lineStart = spokesStart + i * SPOKE_STAGGER;
        const lineLen = Math.sqrt((pos.x - cx) ** 2 + (pos.y - cy) ** 2);
        const lineProgress = interpolate(
          frame - lineStart,
          [0, LINE_DRAW],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

        return (
          <line
            key={`line-${i}`}
            x1={cx}
            y1={cy}
            x2={pos.x}
            y2={pos.y}
            stroke={lineColor}
            strokeWidth={2}
            strokeDasharray={lineLen}
            strokeDashoffset={lineLen * (1 - lineProgress)}
          />
        );
      })}

      {/* Hub node */}
      <g
        style={{
          opacity: hub.opacity,
          transform: `scale(${hub.progress})`,
          transformOrigin: `${cx}px ${cy}px`,
        }}
      >
        <circle cx={cx} cy={cy} r={HUB_R} fill={hubColor} />
        {center.icon && (
          <text
            x={cx}
            y={cy - 10}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={24}
          >
            {center.icon}
          </text>
        )}
        <text
          x={cx}
          y={center.icon ? cy + 15 : cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#FFFFFF"
          fontFamily={fontFamily}
          fontSize={16}
          fontWeight={700}
        >
          {center.label}
        </text>
      </g>

      {/* Spoke nodes — only visible spokes */}
      {spokePositions.map((pos, i) => {
        if (visibleSpokeCount != null && i >= visibleSpokeCount) return null;
        const spokeProgress = spokeNodes.getItemProgress(i);

        return (
          <g
            key={`spoke-${i}`}
            style={{
              opacity: spokeProgress,
              transform: `scale(${spokeProgress})`,
              transformOrigin: `${pos.x}px ${pos.y}px`,
            }}
          >
            {/* Highlight glow ring */}
            {i === highlightIndex && (() => {
              const hlProgress = spring({
                frame: frame - highlightAt,
                fps,
                config: { damping: 8, stiffness: 120 },
              });
              const glowR = interpolate(hlProgress, [0, 1], [SPOKE_R, SPOKE_R + 8]);
              const glowOpacity = interpolate(hlProgress, [0, 1], [0, 0.5]);
              return (
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={glowR}
                  fill="none"
                  stroke={hubColor}
                  strokeWidth={3}
                  style={{ opacity: glowOpacity }}
                />
              );
            })()}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={SPOKE_R}
              fill={i === highlightIndex ? hubColor : spokeColor}
              stroke={i === highlightIndex ? hubColor : theme.colors.border}
              strokeWidth={1.5}
            />
            {spokes[i].icon && (
              <text
                x={pos.x}
                y={pos.y - 8}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={20}
              >
                {spokes[i].icon}
              </text>
            )}
            <text
              x={pos.x}
              y={spokes[i].icon ? pos.y + 12 : pos.y}
              textAnchor="middle"
              dominantBaseline="central"
              fill={theme.colors.foreground}
              fontFamily={fontFamily}
              fontSize={14}
              fontWeight={600}
            >
              {spokes[i].label}
            </text>
          </g>
        );
      })}
    </svg>
  );
});
