/**
 * ChatThread — staggered stack of chat bubbles.
 *
 * Renders bubbles as rounded pills with one corner squared off (the "tail"),
 * each entering with a spring slide-in from the bubble's aligned side.
 * Supports optional avatar glyph next to each bubble.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { fontFamily } from "../../config/fonts";
import { BRAND, VIDEO_COLORS } from "../../config/defaults";

export interface ChatBubble {
  text: string;
  align?: "left" | "right";
  style?: "user" | "assistant";
  avatar?: string;
}

export interface ChatThreadProps {
  bubbles: ChatBubble[];
  /** Stagger between bubble entries in seconds. Default 0.6. */
  stagger?: number;
  /** Frame to start the first bubble. Default 0. */
  startAt?: number;
  /** Max bubble width as a fraction of viewport width. Default 0.8. */
  maxWidthFrac?: number;
}

const USER_BG = BRAND.primary;
const ASSISTANT_BG = "#1F2937"; // neutral slate so contrast holds on dark bg
const TEXT_COLOR = "#FFFFFF";

export const ChatThread: React.FC<ChatThreadProps> = ({
  bubbles,
  stagger = 0.6,
  startAt = 0,
  maxWidthFrac = 0.8,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const staggerFrames = Math.max(1, Math.round(stagger * fps));
  const maxBubbleWidth = Math.round(width * maxWidthFrac);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 28,
        padding: "0 80px",
        boxSizing: "border-box",
        fontFamily,
      }}
    >
      {bubbles.map((bubble, i) => {
        const align = bubble.align ?? "right";
        const style = bubble.style ?? "user";
        const bubbleStart = startAt + i * staggerFrames;

        const progress = spring({
          frame: frame - bubbleStart,
          fps,
          config: { damping: 14, stiffness: 140 },
        });

        const slideFrom = align === "right" ? 120 : -120;
        const translateX = interpolate(progress, [0, 1], [slideFrom, 0]);
        const opacity = progress;

        const bg = style === "assistant" ? ASSISTANT_BG : USER_BG;
        const isRight = align === "right";

        // Asymmetric border radius — squared corner is the "tail" side.
        const radius = 28;
        const tailRadius = 6;
        const borderRadius = isRight
          ? `${radius}px ${radius}px ${tailRadius}px ${radius}px`
          : `${radius}px ${radius}px ${radius}px ${tailRadius}px`;

        const bubbleEl = (
          <div
            style={{
              maxWidth: maxBubbleWidth,
              padding: "20px 28px",
              backgroundColor: bg,
              color: TEXT_COLOR,
              borderRadius,
              fontSize: 38,
              fontWeight: 600,
              lineHeight: 1.3,
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
              wordBreak: "break-word",
            }}
          >
            {bubble.text}
          </div>
        );

        const avatarEl = bubble.avatar ? (
          <div
            style={{
              width: 56,
              height: 56,
              flexShrink: 0,
              borderRadius: "50%",
              backgroundColor: style === "assistant" ? BRAND.primary : VIDEO_COLORS.border,
              color: TEXT_COLOR,
              fontSize: 26,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {bubble.avatar}
          </div>
        ) : null;

        return (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: isRight ? "row-reverse" : "row",
              alignItems: "flex-end",
              gap: 16,
              opacity,
              transform: `translateX(${translateX}px)`,
              alignSelf: isRight ? "flex-end" : "flex-start",
            }}
          >
            {avatarEl}
            {bubbleEl}
          </div>
        );
      })}
    </div>
  );
};
