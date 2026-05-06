import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "../themes/ThemeProvider";
import { monoFontFamily } from "../../config/fonts";

export interface TypeWriterProps {
  text: string;
  speed?: number; // characters per second
  startAt?: number;
  cursor?: boolean;
  cursorStyle?: "bar" | "underscore" | "block";
  cursorBlinkSpeed?: number; // frames per blink cycle
  fontSize?: number;
  color?: string;
  style?: React.CSSProperties;
}

export const TypeWriter: React.FC<TypeWriterProps> = ({
  text,
  speed = 30,
  startAt = 0,
  cursor = true,
  cursorStyle = "bar",
  cursorBlinkSpeed = 15,
  fontSize,
  color,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();

  const elapsed = Math.max(0, frame - startAt);
  const charsPerFrame = speed / fps;
  const visibleChars = Math.min(Math.floor(elapsed * charsPerFrame), text.length);
  const displayText = text.slice(0, visibleChars);
  const isTyping = visibleChars < text.length;

  // Cursor blinks when typing is done
  const showCursor =
    cursor && (isTyping || Math.floor(elapsed / cursorBlinkSpeed) % 2 === 0);

  const cursorChar =
    cursorStyle === "underscore" ? "_" : cursorStyle === "block" ? "\u2588" : "|";

  return (
    <span
      style={{
        fontFamily: monoFontFamily,
        fontSize: fontSize || theme.typography.fontSize.lg,
        color: color || theme.colors.foreground,
        whiteSpace: "pre-wrap",
        ...style,
      }}
    >
      {displayText}
      {showCursor && (
        <span style={{ color: theme.colors.primary, opacity: 0.8 }}>{cursorChar}</span>
      )}
    </span>
  );
};
