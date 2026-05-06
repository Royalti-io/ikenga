/**
 * Syntax-highlighted code display using pre-highlighted Shiki tokens.
 *
 * Shiki runs in Node.js, so highlighting must happen in calculateMetadata.
 * This component renders pre-computed HTML tokens as styled spans.
 *
 * Usage in calculateMetadata:
 *   import { highlightCode } from '../../lib/shiki-highlight';
 *   const highlighted = await highlightCode(code, 'typescript');
 *   return { props: { ...props, highlightedHtml: highlighted } };
 */

import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing } from "../../remotion-ui/core/easing";
import { useTheme } from "../../remotion-ui/themes/ThemeProvider";
import { monoFontFamily } from "../../config/fonts";

export type CodeRevealMode = "instant" | "lineByLine" | "typewriter";

export interface CodeBlockProps {
  /** Pre-highlighted HTML lines from Shiki (via calculateMetadata). */
  lines: CodeLine[];
  highlightLines?: number[];
  revealMode?: CodeRevealMode;
  startAt?: number;
  framesPerLine?: number;
  fontSize?: number;
  style?: React.CSSProperties;
}

export interface CodeLine {
  /** HTML content for this line (from Shiki tokenization). */
  html: string;
  /** Line number (1-based). */
  lineNumber: number;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  lines,
  highlightLines = [],
  revealMode = "instant",
  startAt = 0,
  framesPerLine = 4,
  fontSize,
  style,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();

  const highlightSet = new Set(highlightLines);

  return (
    <div
      style={{
        backgroundColor: "#1a1a2e",
        borderRadius: theme.radius.lg,
        padding: `${theme.spacing[6]}px ${theme.spacing[8]}px`,
        border: `1px solid ${theme.colors.border}`,
        overflow: "hidden",
        ...style,
      }}
    >
      {/* Window chrome dots */}
      <div style={{ display: "flex", gap: 8, marginBottom: theme.spacing[4] }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#ff5f57" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#febc2e" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#28c840" }} />
      </div>

      <pre
        style={{
          fontFamily: monoFontFamily,
          fontSize: fontSize || theme.typography.fontSize.base,
          lineHeight: theme.typography.lineHeight.relaxed,
          margin: 0,
        }}
      >
        {lines.map((line, i) => {
          let opacity = 1;
          let translateY = 0;

          if (revealMode === "lineByLine") {
            const lineStart = startAt + i * framesPerLine;
            opacity = interpolateWithEasing(
              frame,
              [lineStart, lineStart + framesPerLine],
              [0, 1],
              "ease-out",
            );
            translateY = interpolateWithEasing(
              frame,
              [lineStart, lineStart + framesPerLine],
              [6, 0],
              "ease-out",
            );
          } else if (revealMode === "typewriter") {
            const lineStart = startAt + i * framesPerLine;
            opacity = frame >= lineStart ? 1 : 0;
          }

          const isHighlighted = highlightSet.has(line.lineNumber);

          return (
            <div
              key={line.lineNumber}
              style={{
                opacity,
                transform: `translateY(${translateY}px)`,
                backgroundColor: isHighlighted
                  ? "rgba(0, 102, 102, 0.15)"
                  : "transparent",
                padding: "0 4px",
                borderLeft: isHighlighted
                  ? `3px solid ${theme.colors.primary}`
                  : "3px solid transparent",
              }}
              dangerouslySetInnerHTML={{ __html: line.html }}
            />
          );
        })}
      </pre>
    </div>
  );
};
