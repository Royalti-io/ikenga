import React from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { useStaggeredReveal } from "../../hooks";
import { SPRING_CONFIGS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";

export interface FlowChartStep {
  label: string;
  icon?: string;
  description?: string;
}

export interface FlowChartProps {
  steps: FlowChartStep[];
  direction?: "vertical" | "horizontal";
  arrowStyle?: "solid" | "dashed";
  colorScheme?: { node: string; arrow: string; text: string };
  delay?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  /** Index of step to highlight with a pulse glow. -1 or undefined = no highlight. */
  highlightIndex?: number;
  /** Frame at which the highlight pulse starts. */
  highlightAt?: number;
  /** V3: Show only the first N steps (progressive reveal). undefined = show all. */
  visibleCount?: number;
}

const NODE_W = 220;
const NODE_H = 70;
const NODE_RADIUS = 14;
const ARROW_HEAD = 10;
const ANIM_NODE = 15; // frames per node entrance
const ANIM_ARROW = 15; // frames per arrow draw

export const FlowChart = React.memo<FlowChartProps>(({
  steps,
  direction = "horizontal",
  arrowStyle = "solid",
  colorScheme,
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  highlightIndex = -1,
  highlightAt = 60,
  visibleCount,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const theme = useTheme();

  const canvasWidth = canvasWidthProp ?? width;
  const canvasHeight = canvasHeightProp ?? height;

  const nodeColor = colorScheme?.node ?? theme.colors.primary;
  const arrowColor = colorScheme?.arrow ?? theme.colors.mutedForeground;
  const textColor = colorScheme?.text ?? theme.colors.foreground;

  // V3: Progressive reveal — only show first N steps, but keep layout stable
  const effectiveSteps = visibleCount != null ? steps.slice(0, visibleCount) : steps;
  const n = steps.length; // Use FULL count for layout (prevents position shifts)
  const isH = direction === "horizontal";

  // Calculate positions based on FULL steps array (stable layout)
  const positions = steps.map((_, i) => {
    if (isH) {
      const totalW = n * NODE_W + (n - 1) * 60;
      const startX = (canvasWidth - totalW) / 2;
      return {
        x: startX + i * (NODE_W + 60),
        y: canvasHeight / 2 - NODE_H / 2,
      };
    } else {
      const gap = 50;
      const totalH = n * NODE_H + (n - 1) * gap;
      const startY = (canvasHeight - totalH) / 2;
      return {
        x: canvasWidth / 2 - NODE_W / 2,
        y: startY + i * (NODE_H + gap),
      };
    }
  });

  // Each step takes ANIM_NODE frames for node + ANIM_ARROW frames for arrow
  const stepDuration = ANIM_NODE + ANIM_ARROW;

  // Staggered node reveal
  const nodes = useStaggeredReveal({
    count: effectiveSteps.length,
    stagger: stepDuration,
    delay,
    springConfig: SPRING_CONFIGS.SNAPPY,
  });

  return (
    <svg
      width={canvasWidth}
      height={canvasHeight}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{ position: "absolute", inset: 0 }}
    >
      {effectiveSteps.map((step, i) => {
        const pos = positions[i];
        const nodeStart = delay + i * stepDuration;
        const nodeProgress = nodes.getItemProgress(i);

        // Arrow to next node (if not last) — uses useLineDrawSVG inline pattern
        // since each arrow has unique geometry
        const nextPos = i < n - 1 ? positions[i + 1] : null;

        // Arrow geometry
        let arrowPath = "";
        let arrowLen = 0;
        let headX1 = 0, headY1 = 0, headX2 = 0, headY2 = 0;
        let headTipX = 0, headTipY = 0;

        if (nextPos) {
          if (isH) {
            const x1 = pos.x + NODE_W;
            const y1 = pos.y + NODE_H / 2;
            const x2 = nextPos.x;
            const y2 = nextPos.y + NODE_H / 2;
            arrowPath = `M${x1},${y1} L${x2},${y2}`;
            arrowLen = x2 - x1;
            headTipX = x2;
            headTipY = y2;
            headX1 = x2 - ARROW_HEAD;
            headY1 = y2 - ARROW_HEAD / 2;
            headX2 = x2 - ARROW_HEAD;
            headY2 = y2 + ARROW_HEAD / 2;
          } else {
            const x1 = pos.x + NODE_W / 2;
            const y1 = pos.y + NODE_H;
            const x2 = nextPos.x + NODE_W / 2;
            const y2 = nextPos.y;
            arrowPath = `M${x1},${y1} L${x2},${y2}`;
            arrowLen = y2 - y1;
            headTipX = x2;
            headTipY = y2;
            headX1 = x2 - ARROW_HEAD / 2;
            headY1 = y2 - ARROW_HEAD;
            headX2 = x2 + ARROW_HEAD / 2;
            headY2 = y2 - ARROW_HEAD;
          }
        }

        // Arrow progress — keep inline interpolate since each arrow has per-node timing
        let arrowProgress = 0;
        if (i < n - 1) {
          const arrowStart = nodeStart + ANIM_NODE;
          arrowProgress = interpolate(
            frame - arrowStart,
            [0, ANIM_ARROW],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          );
        }

        return (
          <g key={i}>
            {/* Node */}
            <g
              style={{
                opacity: nodeProgress,
                transform: `scale(${0.8 + nodeProgress * 0.2})`,
                transformOrigin: `${pos.x + NODE_W / 2}px ${pos.y + NODE_H / 2}px`,
              }}
            >
              {/* Highlight glow ring */}
              {i === highlightIndex && (() => {
                const hlProgress = spring({
                  frame: frame - highlightAt,
                  fps,
                  config: { damping: 8, stiffness: 120 },
                });
                const glowScale = interpolate(hlProgress, [0, 1], [0.9, 1.08]);
                const glowOpacity = interpolate(hlProgress, [0, 1], [0, 0.6]);
                return (
                  <rect
                    x={pos.x - 4}
                    y={pos.y - 4}
                    width={NODE_W + 8}
                    height={NODE_H + 8}
                    rx={NODE_RADIUS + 2}
                    fill="none"
                    stroke={nodeColor}
                    strokeWidth={3}
                    style={{
                      opacity: glowOpacity,
                      transform: `scale(${glowScale})`,
                      transformOrigin: `${pos.x + NODE_W / 2}px ${pos.y + NODE_H / 2}px`,
                    }}
                  />
                );
              })()}
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={NODE_RADIUS}
                fill={i === highlightIndex ? theme.colors.primary : nodeColor}
              />
              <text
                x={pos.x + NODE_W / 2}
                y={pos.y + NODE_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill={textColor}
                fontFamily={fontFamily}
                fontSize={20}
                fontWeight={600}
              >
                {step.label}
              </text>
              {step.description && (
                <text
                  x={pos.x + NODE_W / 2}
                  y={isH ? pos.y + NODE_H + 24 : pos.y - 12}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={theme.colors.mutedForeground}
                  fontFamily={fontFamily}
                  fontSize={14}
                >
                  {step.description}
                </text>
              )}
            </g>

            {/* Arrow to next */}
            {nextPos && arrowLen > 0 && (
              <g>
                <path
                  d={arrowPath}
                  stroke={arrowColor}
                  strokeWidth={2}
                  fill="none"
                  strokeDasharray={arrowStyle === "dashed" ? "8 4" : arrowLen}
                  strokeDashoffset={
                    arrowStyle === "dashed"
                      ? 0
                      : arrowLen * (1 - arrowProgress)
                  }
                  style={{
                    opacity: arrowStyle === "dashed"
                      ? arrowProgress
                      : 1,
                  }}
                />
                {/* Arrowhead */}
                <polygon
                  points={`${headTipX},${headTipY} ${headX1},${headY1} ${headX2},${headY2}`}
                  fill={arrowColor}
                  style={{ opacity: arrowProgress }}
                />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
});
