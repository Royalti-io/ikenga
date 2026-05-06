/**
 * ParallaxBackground — subtle animated background layer.
 *
 * Creates depth behind content with slow-moving gradient and
 * abstract geometric shapes. Uses useCurrentFrame() for continuous
 * motion that never stops.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { VIDEO_COLORS, BRAND } from "../../config/defaults";

export interface ParallaxBackgroundProps {
  /** Speed multiplier (0.5 = half speed, 2 = double). Default: 1 */
  speed?: number;
  /** Show subtle geometric shapes. Default: true */
  showShapes?: boolean;
}

export const ParallaxBackground: React.FC<ParallaxBackgroundProps> = ({
  speed = 1,
  showShapes = true,
}) => {
  const frame = useCurrentFrame();
  const t = frame * speed;

  // Slow gradient rotation
  const gradientAngle = 135 + Math.sin(t * 0.005) * 15;
  const gradientShift = Math.sin(t * 0.003) * 5;

  return (
    <AbsoluteFill>
      {/* Animated gradient base */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(${gradientAngle}deg, ${VIDEO_COLORS.background} 0%, ${BRAND.gradientTo}${Math.round(15 + gradientShift).toString(16)} 50%, ${VIDEO_COLORS.background} 100%)`,
        }}
      />

      {/* Subtle geometric shapes */}
      {showShapes && (
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 1920 1080"
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.04,
          }}
        >
          {/* Floating circle 1 */}
          <circle
            cx={960 + Math.sin(t * 0.008) * 100}
            cy={540 + Math.cos(t * 0.006) * 60}
            r={200}
            fill="none"
            stroke={BRAND.primary}
            strokeWidth={1}
          />
          {/* Floating circle 2 */}
          <circle
            cx={400 + Math.cos(t * 0.005) * 80}
            cy={300 + Math.sin(t * 0.007) * 50}
            r={120}
            fill="none"
            stroke={BRAND.info}
            strokeWidth={0.5}
          />
          {/* Diagonal line */}
          <line
            x1={0}
            y1={1080}
            x2={1920}
            y2={-100 + Math.sin(t * 0.004) * 50}
            stroke={BRAND.primary}
            strokeWidth={0.5}
          />
          {/* Small dot grid (static, gives texture) */}
          {Array.from({ length: 8 }).map((_, i) =>
            Array.from({ length: 5 }).map((_, j) => (
              <circle
                key={`dot-${i}-${j}`}
                cx={240 * (i + 1) + Math.sin(t * 0.003 + i) * 5}
                cy={216 * (j + 1) + Math.cos(t * 0.003 + j) * 5}
                r={1.5}
                fill={BRAND.primary}
              />
            )),
          )}
        </svg>
      )}
    </AbsoluteFill>
  );
};
