/**
 * NoiseBackground — organic animated background using Perlin noise.
 *
 * Creates a living, breathing background texture that replaces
 * flat solid colors. Uses @remotion/noise for deterministic
 * noise generation.
 *
 * @example
 * <NoiseBackground />
 * <NoiseBackground speed={0.5} scale={0.005} color1="#0D0D0D" color2="#006666" />
 */

import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { noise2D } from "@remotion/noise";

export interface NoiseBackgroundProps {
  /** Animation speed multiplier. Default: 1 */
  speed?: number;
  /** Noise scale (smaller = larger blobs). Default: 0.003 */
  scale?: number;
  /** Base/dark color. Default: VIDEO_COLORS.background (#0D0D0D) */
  color1?: string;
  /** Accent/light color blended in via noise. Default: BRAND.primary (#006666) */
  color2?: string;
  /** Max opacity of the noise overlay. Default: 0.15 */
  opacity?: number;
  /** Grid resolution (cells per axis). Higher = smoother but slower. Default: 64 */
  resolution?: number;
}

export const NoiseBackground: React.FC<NoiseBackgroundProps> = ({
  speed = 1,
  scale = 0.003,
  color1 = "#0D0D0D",
  color2 = "#006666",
  opacity = 0.15,
  resolution = 64,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cellW = width / resolution;
  const cellH = height / resolution;
  const t = frame * speed * 0.01;

  const cells = useMemo(() => {
    const result: Array<{ x: number; y: number; value: number }> = [];
    for (let ix = 0; ix < resolution; ix++) {
      for (let iy = 0; iy < resolution; iy++) {
        const nx = ix * scale * 100;
        const ny = iy * scale * 100;
        const value = (noise2D("royalti-bg", nx + t, ny + t) + 1) / 2; // normalize 0-1
        result.push({ x: ix * cellW, y: iy * cellH, value });
      }
    }
    return result;
  }, [t, resolution, scale, cellW, cellH]);

  return (
    <AbsoluteFill>
      {/* Solid base color */}
      <AbsoluteFill style={{ backgroundColor: color1 }} />

      {/* Noise overlay */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0 }}
      >
        {cells.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={cellW + 1}
            height={cellH + 1}
            fill={color2}
            opacity={cell.value * opacity}
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};
