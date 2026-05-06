/**
 * ChatBubble — chat-bubble metaphor for AI / messaging product compositions.
 *
 * Replaces hand-rolled bubble divs (QueryBubble) in AskRoyClipVideo.
 * Phase 3 will migrate AskRoy to use this primitive.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";
import { useStoryboard } from "@/video/remotion-ui/themes/StoryboardProvider";
import { useNarrationSync } from "@/video/lib/use-narration-sync";
import { fontFamily } from "@/video/config/fonts";

// ── Types ──────────────────────────────────────────────────────────────────

export type ChatBubbleProps = {
  side: "left" | "right";
  /** "user" = right-side accent tone, "assistant" = left-side surface tone. Default infers from side. */
  tone?: "user" | "assistant";
  /** Optional inline avatar glyph. */
  avatar?: string;
  /** Animation entrance frame. Default 0. */
  startAt?: number;
  /** Optional reveal sync to a narration word. */
  revealAtWord?: string;
  /** Max bubble width (fraction of container). Default 0.82. */
  maxWidth?: number;
  children: React.ReactNode;
};

// ── Component ──────────────────────────────────────────────────────────────

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  side,
  tone,
  avatar,
  startAt = 0,
  revealAtWord,
  maxWidth = 0.82,
  children,
}) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const storyboard = useStoryboard();

  // Resolve reveal frame: narration word → frame, else fall back to startAt.
  // useNarrationSync is a plain function (no React deps) — safe to call here.
  const narrationWords = storyboard.narration?.words ?? [];
  const sync = useNarrationSync({ words: narrationWords, fps });
  let resolvedStart = startAt;
  if (revealAtWord && storyboard.narration) {
    resolvedStart = sync.frameForWord(revealAtWord) ?? startAt;
  }

  const relFrame = frame - resolvedStart;
  const effectiveTone = tone ?? (side === "right" ? "user" : "assistant");
  const isUser = effectiveTone === "user";

  const p = spring({ frame: relFrame, fps, config: { damping: 14, stiffness: 110, mass: 0.7 } });

  const opacity = Math.min(p, 1);
  const translateY = (1 - p) * 24;
  const scale = palette.lofi ? 1 : 0.96 + p * 0.04;

  const bg = isUser ? palette.accent : palette.surface;
  const border = isUser ? palette.highlight : palette.border;
  const radius = isUser ? "26px 26px 6px 26px" : "26px 26px 26px 6px";
  const align = side === "right" ? "flex-end" : "flex-start";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align }}>
      <div style={{ display: "flex", flexDirection: side === "right" ? "row-reverse" : "row", alignItems: "flex-end", gap: 12 }}>
        {avatar && (
          <div style={{
            width: 40, height: 40, borderRadius: 20,
            backgroundColor: palette.surface,
            border: `1px solid ${palette.border}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily, fontSize: 20, color: palette.textPri, flexShrink: 0,
          }}>
            {avatar}
          </div>
        )}
        <div
          style={{
            maxWidth: `${maxWidth * 100}%`,
            backgroundColor: bg,
            border: `1px solid ${border}`,
            borderRadius: radius,
            padding: "22px 28px",
            fontFamily, fontSize: 34, fontWeight: 600,
            color: palette.textPri, lineHeight: 1.35,
            letterSpacing: "-0.005em",
            opacity,
            transform: `translateY(${translateY}px) scale(${scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
