/**
 * AnimatedCalculation — displays a math formula with staggered reveal.
 * Each part (dividend, operator, divisor, result) appears in sequence.
 *
 * V6: Uses useStaggeredReveal + useProgressBar hooks.
 */

import React from "react";
import { useVideoConfig } from "remotion";
import { useStaggeredReveal, useProgressBar } from "../../hooks";
import { fontFamily } from "../../config/fonts";
import { VIDEO_COLORS, BRAND, SPRING_CONFIGS } from "../../config/defaults";

export interface AnimatedCalculationProps {
  dividend: string;
  divisor: string;
  result: string;
  label?: string;
  delay?: number;
}

const PART_STAGGER = 15;

export const AnimatedCalculation = React.memo<AnimatedCalculationProps>(({
  dividend,
  divisor,
  result,
  label,
  delay = 10,
}) => {
  const { width, height } = useVideoConfig();

  const parts = [
    { text: dividend, color: VIDEO_COLORS.text },
    { text: "÷", color: VIDEO_COLORS.mutedText },
    { text: divisor, color: VIDEO_COLORS.text },
    { text: "=", color: VIDEO_COLORS.mutedText },
    { text: result, color: BRAND.primary },
  ];

  const reveal = useStaggeredReveal({
    count: parts.length,
    stagger: PART_STAGGER,
    delay,
    springConfig: { damping: 16, stiffness: 100 },
  });

  const labelBar = useProgressBar({
    delay: delay + parts.length * PART_STAGGER,
    springConfig: SPRING_CONFIGS.SLOW,
  });

  return (
    <div style={{ width, height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
        {parts.map((part, i) => (
          <div key={i} style={{
            fontFamily,
            fontSize: i === 1 || i === 3 ? 48 : 56,
            fontWeight: i === 4 ? 800 : 600,
            color: part.color,
            opacity: reveal.getItemOpacity(i),
            transform: `translateY(${reveal.getItemTranslateY(i, 30)}px) scale(${i === 4 ? reveal.getItemScale(i) : 1})`,
          }}>
            {part.text}
          </div>
        ))}
      </div>

      {label && (
        <div style={{
          fontFamily,
          fontSize: 24,
          color: VIDEO_COLORS.mutedText,
          marginTop: 32,
          opacity: labelBar.opacity,
        }}>
          {label}
        </div>
      )}
    </div>
  );
});
