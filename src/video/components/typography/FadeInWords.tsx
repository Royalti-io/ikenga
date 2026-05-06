import React from "react";
import { useCurrentFrame } from "remotion";
import { interpolateWithEasing } from "../../remotion-ui/core/easing";
import { fontFamily } from "../../config/fonts";
import { VIDEO_COLORS, FONT } from "../../config/defaults";

export interface FadeInWordsProps {
  text: string;
  startAt?: number;
  framesPerWord?: number;
  fontSize?: number;
  color?: string;
  style?: React.CSSProperties;
}

export const FadeInWords: React.FC<FadeInWordsProps> = ({
  text,
  startAt = 0,
  framesPerWord = 5,
  fontSize = FONT.bodySize,
  color = VIDEO_COLORS.text,
  style,
}) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        color,
        display: "flex",
        flexWrap: "wrap",
        gap: "0.3em",
        justifyContent: "center",
        ...style,
      }}
    >
      {words.map((word, i) => {
        const wordStart = startAt + i * framesPerWord;
        const opacity = interpolateWithEasing(
          frame,
          [wordStart, wordStart + framesPerWord],
          [0, 1],
          "ease-out",
        );
        const translateY = interpolateWithEasing(
          frame,
          [wordStart, wordStart + framesPerWord],
          [8, 0],
          "ease-out",
        );

        return (
          <span
            key={i}
            style={{
              opacity,
              transform: `translateY(${translateY}px)`,
              display: "inline-block",
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};
