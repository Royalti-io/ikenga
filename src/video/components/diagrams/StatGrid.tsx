import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { useStaggeredReveal } from "../../hooks";
import { SPRING_CONFIGS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";
import { AnimatedNumber, type NumberFormat } from "../../remotion-ui/dataviz/AnimatedNumber";

export interface StatGridItem {
  value: number;
  label: string;
  prefix?: string;
  suffix?: string;
  format?: "plain" | "currency" | "percent" | "compact";
}

export interface StatGridProps {
  stats: StatGridItem[];
  columns?: 2 | 3 | 4;
  delay?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  /** V3: Index of stat to highlight with a glow ring. -1 or undefined = no highlight. */
  highlightIndex?: number;
}

const CELL_STAGGER = 6;
const NUMBER_DURATION = 30;

// Map StatGrid format to AnimatedNumber format
const formatMap: Record<string, NumberFormat> = {
  plain: "number",
  currency: "currency",
  percent: "percent",
  compact: "compact",
};

export const StatGrid = React.memo<StatGridProps>(({
  stats,
  columns = 3,
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  highlightIndex = -1,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const theme = useTheme();

  const canvasWidth = canvasWidthProp ?? width;
  void (canvasHeightProp ?? height);

  const layout = useMemo(() => {
    const rows = Math.ceil(stats.length / columns);
    const cellW = Math.min(320, (canvasWidth - 200) / columns);
    const cellH = 160;
    const gapX = 30;
    const gapY = 30;
    const gridW = columns * cellW + (columns - 1) * gapX;
    const gridH = rows * cellH + (rows - 1) * gapY;
    return { rows, cellW, cellH, gapX, gapY, gridW, gridH };
  }, [stats.length, columns, canvasWidth]);
  const { cellW, cellH, gapX, gapY } = layout;

  // Staggered cell reveal
  const cells = useStaggeredReveal({
    count: stats.length,
    stagger: CELL_STAGGER,
    delay,
    springConfig: SPRING_CONFIGS.SNAPPY,
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, ${cellW}px)`,
          gap: `${gapY}px ${gapX}px`,
        }}
      >
        {stats.map((stat, i) => {
          const cellStart = delay + i * CELL_STAGGER;
          const cellProgress = cells.getItemProgress(i);

          const labelStart = cellStart + NUMBER_DURATION;
          const labelOpacity = interpolate(
            frame - labelStart,
            [0, 10],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          );

          const isHighlighted = i === highlightIndex;

          return (
            <div
              key={i}
              style={{
                backgroundColor: theme.colors.card,
                borderRadius: theme.radius.lg,
                border: isHighlighted
                  ? `2px solid ${theme.colors.primary}`
                  : `1px solid ${theme.colors.border}`,
                boxShadow: isHighlighted
                  ? `0 0 20px ${theme.colors.primary}44`
                  : undefined,
                padding: `${theme.spacing[6]}px ${theme.spacing[4]}px`,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: cellH,
                opacity: cellProgress,
                transform: `scale(${0.85 + cellProgress * 0.15})`,
              }}
            >
              <AnimatedNumber
                value={stat.value}
                format={formatMap[stat.format ?? "plain"]}
                startAt={cellStart}
                durationInFrames={NUMBER_DURATION}
                prefix={stat.prefix}
                suffix={stat.suffix}
                fontSize={theme.typography.fontSize["3xl"]}
              />
              <div
                style={{
                  fontFamily,
                  fontSize: theme.typography.fontSize.sm,
                  color: theme.colors.mutedForeground,
                  marginTop: theme.spacing[2],
                  opacity: labelOpacity,
                }}
              >
                {stat.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
