/**
 * PlatformRateChart — animated horizontal bar chart comparing per-stream rates.
 *
 * V6: Uses useStaggeredReveal hook. Bar width still interpolated inline
 * since it's data-driven (proportional to max rate).
 */

import React from "react";
import { useVideoConfig, interpolate } from "remotion";
import { useStaggeredReveal } from "../../hooks";
import { fontFamily } from "../../config/fonts";
import { VIDEO_COLORS, BRAND, SPRING_CONFIGS } from "../../config/defaults";

export interface PlatformRate {
  platform: string;
  rate: number;
  color?: string;
}

export interface PlatformRateChartProps {
  rates: PlatformRate[];
  delay?: number;
}

const BAR_HEIGHT = 64;
const BAR_GAP = 40;
const LABEL_WIDTH = 280;
const VALUE_WIDTH = 180;
const STAGGER = 12;

const DEFAULT_COLORS = ["#1DB954", "#FC3C44", "#FF0000", "#00BFFF"];

export const PlatformRateChart = React.memo<PlatformRateChartProps>(({
  rates,
  delay = 10,
}) => {
  const { width, height } = useVideoConfig();

  if (rates.length === 0) {
    return <div style={{ width, height }} />;
  }

  const maxRate = Math.max(...rates.map((r) => r.rate)) || 1;
  const maxBarWidth = width - LABEL_WIDTH - VALUE_WIDTH - 200;
  const totalHeight = rates.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const startY = (height - totalHeight) / 2;

  const reveal = useStaggeredReveal({
    count: rates.length,
    stagger: STAGGER,
    delay,
    springConfig: SPRING_CONFIGS.SLOW,
  });

  return (
    <div style={{ width, height, position: "relative" }}>
      {rates.map((item, i) => {
        const progress = reveal.getItemProgress(i);
        const barWidth = interpolate(progress, [0, 1], [0, (item.rate / maxRate) * maxBarWidth]);
        const color = item.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
        const y = startY + i * (BAR_HEIGHT + BAR_GAP);

        return (
          <div key={item.platform} style={{
            position: "absolute",
            top: y,
            left: 100,
            display: "flex",
            alignItems: "center",
            opacity: reveal.getItemOpacity(i),
          }}>
            <div style={{
              width: LABEL_WIDTH,
              fontFamily,
              fontSize: 32,
              fontWeight: 700,
              color: VIDEO_COLORS.text,
              textAlign: "right",
              paddingRight: 24,
            }}>
              {item.platform}
            </div>

            <div style={{
              width: barWidth,
              height: BAR_HEIGHT,
              backgroundColor: color,
              borderRadius: 8,
              minWidth: 4,
            }} />

            <div style={{
              width: VALUE_WIDTH,
              fontFamily,
              fontSize: 28,
              fontWeight: 600,
              color: BRAND.primary,
              paddingLeft: 16,
            }}>
              ${item.rate.toFixed(4)}
            </div>
          </div>
        );
      })}

      <div style={{
        position: "absolute",
        top: startY - 80,
        left: 100,
        fontFamily,
        fontSize: 24,
        fontWeight: 500,
        color: VIDEO_COLORS.mutedText,
        letterSpacing: 2,
        textTransform: "uppercase",
      }}>
        Per-Stream Rate Comparison
      </div>
    </div>
  );
});
