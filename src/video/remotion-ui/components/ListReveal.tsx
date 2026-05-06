import React from "react";
import { Stagger } from "../core/Stagger";
import { SlideIn } from "../core/SlideIn";
import { FadeIn } from "../core/FadeIn";
import { useTheme } from "../themes/ThemeProvider";
import { fontFamily } from "../../config/fonts";

export interface ListRevealProps {
  items: string[];
  perItem?: number;
  gap?: number;
  startAt?: number;
  bulletColor?: string;
}

export const ListReveal: React.FC<ListRevealProps> = ({
  items,
  perItem = 8,
  gap = 16,
  startAt = 0,
  bulletColor,
}) => {
  const theme = useTheme();
  const color = bulletColor || theme.colors.primary;

  return (
    <Stagger
      startAt={startAt}
      staggerDelay={perItem}
      style={{ display: "flex", flexDirection: "column", gap }}
    >
      {items.map((item, i) => (
        <SlideIn key={i} from="left" distance={30} durationInFrames={12}>
          <FadeIn durationInFrames={12}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: theme.radius.full,
                  backgroundColor: color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily,
                  fontSize: theme.typography.fontSize.lg,
                  color: theme.colors.foreground,
                }}
              >
                {item}
              </span>
            </div>
          </FadeIn>
        </SlideIn>
      ))}
    </Stagger>
  );
};
