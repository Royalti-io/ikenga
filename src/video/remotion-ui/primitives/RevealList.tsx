/**
 * RevealList — vertical/horizontal list whose items reveal one-by-one.
 * Replaces hand-rolled staggered cards / bullet lists.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { useStoryboard } from "@/video/remotion-ui/themes/StoryboardProvider";
import { useNarrationSync } from "@/video/lib/use-narration-sync";
import { fontFamily } from "@/video/config/fonts";

export type RevealItem = {
  content: string | React.ReactNode;
  revealAtFrame?: number;
  revealAtWord?: string;
  icon?: React.ReactNode;
};

export type RevealListProps = {
  items: RevealItem[];
  stagger?: number;
  pattern?: "stagger" | "linear-narration";
  startAt?: number;
  gap?: number;
  direction?: "vertical" | "horizontal";
};

export const RevealList: React.FC<RevealListProps> = ({
  items,
  stagger = 24,
  pattern = "stagger",
  startAt = 0,
  gap = 28,
  direction = "vertical",
}) => {
  const palette = usePalette();
  const isLofi = palette.lofi === true;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const storyboard = useStoryboard();

  const sync = storyboard.narration
    ? useNarrationSync({ words: storyboard.narration.words, fps })
    : null;

  const resolveFrame = (item: RevealItem, index: number): number => {
    if (item.revealAtWord && sync) {
      const f = sync.frameForWord(item.revealAtWord);
      if (f !== null) return f;
    }
    if (item.revealAtFrame !== undefined) return startAt + item.revealAtFrame;
    if (pattern === "linear-narration" && sync && storyboard.narration) {
      const words = storyboard.narration.words;
      const step = Math.floor(words.length / (items.length + 1));
      const wordIdx = Math.min((index + 1) * step, words.length - 1);
      return Math.floor(words[wordIdx].start * fps);
    }
    return startAt + index * stagger;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: direction === "horizontal" ? "row" : "column",
        gap,
        fontFamily,
      }}
    >
      {items.map((item, i) => {
        const revealFrame = resolveFrame(item, i);
        const p = spring({
          frame: frame - revealFrame,
          fps,
          config: { damping: 16, stiffness: 95, mass: 0.8 },
          from: 0,
          to: 1,
        });
        const tx = direction === "horizontal" ? `translateX(${(1 - p) * -60}px)` : "";
        const ty = direction === "vertical" ? `translateY(${(1 - p) * 24}px)` : "";

        return (
          <div
            key={i}
            style={{
              opacity: p,
              transform: `${tx}${ty}`,
              backgroundColor: palette.surface,
              border: `1px solid ${palette.border}`,
              borderRadius: isLofi ? 4 : 16,
              padding: "16px 20px",
              color: palette.textPri,
              display: "flex",
              alignItems: "center",
              gap: 12,
              boxShadow: isLofi ? "none" : undefined,
            }}
          >
            {item.icon && <span style={{ fontSize: 28 }}>{item.icon}</span>}
            <span>{item.content}</span>
          </div>
        );
      })}
    </div>
  );
};
