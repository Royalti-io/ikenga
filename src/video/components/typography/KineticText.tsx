/**
 * KineticText — full per-character kinetic typography.
 *
 * Modes:
 * - word-reveal: Words appear in sync, key terms get color/scale emphasis
 * - char-fly: Characters fly in from random directions, settle into position
 * - char-scale: Characters scale from 0 with staggered delay
 * - highlight-word: Specific words get color/scale emphasis animation
 * - split-line: Lines slide in from alternate sides
 *
 * Uses spring() for organic motion + interpolate() for per-character transforms.
 */

import React, { useMemo } from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { fontFamily } from "../../config/fonts";
import { VIDEO_COLORS, BRAND } from "../../config/defaults";

export type KineticMode =
  | "word-reveal"
  | "char-fly"
  | "char-scale"
  | "highlight-word"
  | "split-line";

export interface KineticTextProps {
  text: string;
  mode?: KineticMode;
  /** Words that get special emphasis (color + scale). */
  highlightWords?: string[];
  /** Start frame delay. */
  startAt?: number;
  fontSize?: number;
  color?: string;
  highlightColor?: string;
  style?: React.CSSProperties;
}

// ── Seeded random for deterministic animations ───────────────────────────

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

// ── Word Reveal Mode ─────────────────────────────────────────────────────

function WordReveal({
  words,
  startAt,
  fontSize,
  color,
  highlightWords,
  highlightColor,
  style,
}: {
  words: string[];
  startAt: number;
  fontSize: number;
  color: string;
  highlightWords: string[];
  highlightColor: string;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const framesPerWord = 4;
  const highlightSet = new Set(highlightWords.map((w) => w.toLowerCase()));

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        color,
        textAlign: "center",
        lineHeight: 1.3,
        wordSpacing: "0.05em",
        ...style,
      }}
    >
      {words.map((word, i) => {
        const wordStart = startAt + i * framesPerWord;
        const isHighlight = highlightSet.has(word.toLowerCase().replace(/[^a-z0-9]/g, ""));

        const progress = spring({
          frame: frame - wordStart,
          fps,
          config: { damping: 12, stiffness: 120 },
        });

        const opacity = progress;
        const translateY = interpolate(progress, [0, 1], [15, 0]);

        // Highlight: extra scale pulse + color
        const highlightScale = isHighlight
          ? interpolate(
              spring({
                frame: frame - wordStart - 3,
                fps,
                config: { damping: 8, stiffness: 200 },
              }),
              [0, 1],
              [1, 1.15],
            )
          : 1;

        return (
          <React.Fragment key={i}>
            {i > 0 && " "}
            <span
              style={{
                opacity,
                transform: `translateY(${translateY}px) scale(${highlightScale})`,
                transformOrigin: "center",
                display: "inline-block",
                color: isHighlight ? highlightColor : color,
                fontWeight: isHighlight ? 800 : 600,
                padding: isHighlight ? "0 0.12em" : 0,
              }}
            >
              {word}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Char Fly Mode ────────────────────────────────────────────────────────

function CharFly({
  text,
  startAt,
  fontSize,
  color,
  style,
}: {
  text: string;
  startAt: number;
  fontSize: number;
  color: string;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chars = text.split("");
  const framesPerChar = 2;

  // Pre-compute random directions for determinism
  const directions = useMemo(
    () =>
      chars.map((_, i) => ({
        x: (seededRandom(i * 3) - 0.5) * 200,
        y: (seededRandom(i * 3 + 1) - 0.5) * 200,
        rotation: (seededRandom(i * 3 + 2) - 0.5) * 90,
      })),
    [chars.length],
  );

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        color,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        lineHeight: 1.3,
        ...style,
      }}
    >
      {chars.map((char, i) => {
        const charStart = startAt + i * framesPerChar;
        const dir = directions[i];

        const progress = spring({
          frame: frame - charStart,
          fps,
          config: { damping: 10, stiffness: 150 },
        });

        const x = interpolate(progress, [0, 1], [dir.x, 0]);
        const y = interpolate(progress, [0, 1], [dir.y, 0]);
        const rotation = interpolate(progress, [0, 1], [dir.rotation, 0]);
        const opacity = progress;

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `translate(${x}px, ${y}px) rotate(${rotation}deg)`,
              whiteSpace: char === " " ? "pre" : undefined,
              minWidth: char === " " ? "0.25em" : undefined,
            }}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
}

// ── Char Scale Mode ──────────────────────────────────────────────────────

function CharScale({
  text,
  startAt,
  fontSize,
  color,
  style,
}: {
  text: string;
  startAt: number;
  fontSize: number;
  color: string;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chars = text.split("");
  const framesPerChar = 2;

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        color,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        lineHeight: 1.3,
        ...style,
      }}
    >
      {chars.map((char, i) => {
        const charStart = startAt + i * framesPerChar;

        const progress = spring({
          frame: frame - charStart,
          fps,
          config: { damping: 12, stiffness: 180 },
        });

        const scale = interpolate(progress, [0, 1], [0, 1]);
        const opacity = progress;

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `scale(${scale})`,
              whiteSpace: char === " " ? "pre" : undefined,
              minWidth: char === " " ? "0.25em" : undefined,
            }}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
}

// ── Split Line Mode ──────────────────────────────────────────────────────

function SplitLine({
  text,
  startAt,
  fontSize,
  color,
  style,
}: {
  text: string;
  startAt: number;
  fontSize: number;
  color: string;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Split on newlines or by ~40 char chunks
  const lines = text.includes("\n")
    ? text.split("\n").filter(Boolean)
    : splitIntoLines(text, 40);

  const framesPerLine = 8;

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        color,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.4em",
        lineHeight: 1.4,
        ...style,
      }}
    >
      {lines.map((line, i) => {
        const lineStart = startAt + i * framesPerLine;
        const fromLeft = i % 2 === 0;

        const progress = spring({
          frame: frame - lineStart,
          fps,
          config: { damping: 15, stiffness: 120 },
        });

        const translateX = interpolate(
          progress,
          [0, 1],
          [fromLeft ? -120 : 120, 0],
        );
        const opacity = progress;

        return (
          <div
            key={i}
            style={{
              opacity,
              transform: `translateX(${translateX}px)`,
              fontWeight: 600,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function splitIntoLines(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Main Component ───────────────────────────────────────────────────────

export const KineticText: React.FC<KineticTextProps> = ({
  text,
  mode = "word-reveal",
  highlightWords = [],
  startAt = 0,
  fontSize = 48,
  color = VIDEO_COLORS.text,
  highlightColor = BRAND.primary,
  style,
}) => {
  const words = text.split(/\s+/).filter(Boolean);

  switch (mode) {
    case "char-fly":
      return (
        <CharFly
          text={text}
          startAt={startAt}
          fontSize={fontSize}
          color={color}
          style={style}
        />
      );

    case "char-scale":
      return (
        <CharScale
          text={text}
          startAt={startAt}
          fontSize={fontSize}
          color={color}
          style={style}
        />
      );

    case "split-line":
      return (
        <SplitLine
          text={text}
          startAt={startAt}
          fontSize={fontSize}
          color={color}
          style={style}
        />
      );

    case "highlight-word":
    case "word-reveal":
    default:
      return (
        <WordReveal
          words={words}
          startAt={startAt}
          fontSize={fontSize}
          color={color}
          highlightWords={highlightWords}
          highlightColor={highlightColor}
          style={style}
        />
      );
  }
};
