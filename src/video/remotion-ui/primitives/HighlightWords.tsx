/**
 * HighlightWords — renders text with specified words/phrases colored in the
 * accent color. Correctly preserves whitespace around matched segments.
 *
 * Regression: "Run an audit on my catalog splits" must render with spaces
 * intact around "audit" — see __tests__/HighlightWords.test.ts.
 */

import React from "react";
import { usePalette } from "@/video/remotion-ui/themes/BrandProvider";

export type HighlightWordsProps = {
  text: string;
  words: string[];
  /** Override accent color (default: palette.highlight) */
  accent?: string;
  /** Bold highlighted words. Default: true */
  bold?: boolean;
  style?: React.CSSProperties;
  className?: string;
};

/**
 * Split `text` into alternating plain/highlighted segments.
 * Longest phrases are matched first to avoid partial overlap.
 * Whitespace is preserved because we split on phrase boundaries only.
 */
export function splitSegments(
  text: string,
  words: string[],
): Array<{ content: string; highlight: boolean }> {
  if (!words.length) return [{ content: text, highlight: false }];

  // Sort descending by length so multi-word phrases win over single words
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");

  const parts = text.split(regex);
  const lowerWords = sorted.map((w) => w.toLowerCase());

  return parts
    .filter((p) => p.length > 0)
    .map((part) => ({
      content: part,
      highlight: lowerWords.includes(part.toLowerCase()),
    }));
}

export const HighlightWords: React.FC<HighlightWordsProps> = ({
  text,
  words,
  accent,
  bold = true,
  style,
  className,
}) => {
  const palette = usePalette();
  const isLofi = palette.lofi === true;
  const color = accent ?? palette.highlight;

  const segments = splitSegments(text, words);

  return (
    <span style={style} className={className}>
      {segments.map((seg, i) =>
        seg.highlight ? (
          <span
            key={i}
            style={{
              color: isLofi ? palette.textPri : color,
              fontWeight: bold ? 800 : undefined,
              textDecoration: isLofi ? "underline" : undefined,
            }}
          >
            {seg.content}
          </span>
        ) : (
          <React.Fragment key={i}>{seg.content}</React.Fragment>
        ),
      )}
    </span>
  );
};
