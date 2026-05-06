import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing } from "../core/easing";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export type NumberFormat = "number" | "currency" | "percent" | "compact";

export interface AnimatedNumberProps {
  value: number;
  format?: NumberFormat;
  startAt?: number;
  durationInFrames?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  locale?: string;
  currency?: string;
  fontSize?: number;
  color?: string;
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  format = "number",
  startAt = 0,
  durationInFrames = 40,
  decimals = 0,
  prefix = "",
  suffix = "",
  locale = "en-US",
  currency = "USD",
  fontSize,
  color,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();

  const currentValue = interpolateWithEasing(
    frame,
    [startAt, startAt + durationInFrames],
    [0, value],
    "ease-out-cubic",
  );

  const formatNumber = (n: number): string => {
    switch (format) {
      case "currency":
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n);
      case "percent":
        return new Intl.NumberFormat(locale, {
          style: "percent",
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n / 100);
      case "compact":
        return new Intl.NumberFormat(locale, {
          notation: "compact",
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n);
      default:
        return new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n);
    }
  };

  return (
    <span
      style={{
        fontFamily,
        fontSize: fontSize || theme.typography.fontSize["4xl"],
        fontWeight: theme.typography.fontWeight.bold,
        color: color || theme.colors.foreground,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {prefix}
      {formatNumber(currentValue)}
      {suffix}
    </span>
  );
};
