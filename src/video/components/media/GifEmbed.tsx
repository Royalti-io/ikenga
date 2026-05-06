/**
 * GifEmbed — frame-synced GIF playback in Remotion compositions.
 *
 * Uses @remotion/gif for deterministic GIF rendering that stays
 * in sync with the composition timeline.
 *
 * @example
 * <GifEmbed src="gifs/reaction.gif" />
 * <GifEmbed src="gifs/demo.gif" fit="contain" />
 */

import React from "react";
import { staticFile } from "remotion";
import { Gif } from "@remotion/gif";

export interface GifEmbedProps {
  /** Path relative to public/ directory (e.g. "gifs/reaction.gif") */
  src: string;
  /** Object fit mode. Default: "contain" */
  fit?: "contain" | "cover" | "fill";
  /** Width override. Default: 100% */
  width?: number | string;
  /** Height override. Default: 100% */
  height?: number | string;
  /** Container style overrides */
  style?: React.CSSProperties;
}

export const GifEmbed: React.FC<GifEmbedProps> = ({
  src,
  fit = "contain",
  width = "100%",
  height = "100%",
  style,
}) => {
  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      <Gif
        src={staticFile(src)}
        fit={fit}
        width={typeof width === "number" ? width : undefined}
        height={typeof height === "number" ? height : undefined}
        style={{ maxWidth: "100%", maxHeight: "100%" }}
      />
    </div>
  );
};
