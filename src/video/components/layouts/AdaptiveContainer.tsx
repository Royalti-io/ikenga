/**
 * AdaptiveContainer — adjusts font scale, padding, and spacing based on aspect ratio.
 *
 * NOT a responsive reflow — just scale factor and margin adjustments so content
 * stays readable across landscape (1920×1080), portrait (1080×1920), and square (1080×1080).
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import { useAspectRatio, type AspectRatioType } from "../../hooks/useAspectRatio";

export interface AdaptiveContainerProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

interface AdaptiveScale {
  fontScale: number;
  paddingH: number;
  paddingV: number;
}

const SCALES: Record<AspectRatioType, AdaptiveScale> = {
  landscape: { fontScale: 1, paddingH: 80, paddingV: 80 },
  portrait: { fontScale: 0.8, paddingH: 40, paddingV: 60 },
  square: { fontScale: 0.85, paddingH: 60, paddingV: 60 },
};

export const AdaptiveContainer: React.FC<AdaptiveContainerProps> = ({
  children,
  style,
}) => {
  const aspect = useAspectRatio();
  const scale = SCALES[aspect];

  return (
    <AbsoluteFill
      style={{
        padding: `${scale.paddingV}px ${scale.paddingH}px`,
        fontSize: `${scale.fontScale}em`,
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * Get the adaptive scale factors for manual use outside AdaptiveContainer.
 */
export function useAdaptiveScale(): AdaptiveScale & { aspect: AspectRatioType } {
  const aspect = useAspectRatio();
  return { ...SCALES[aspect], aspect };
}
