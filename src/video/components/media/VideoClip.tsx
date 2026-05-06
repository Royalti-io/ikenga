import React from "react";
import { OffthreadVideo, staticFile } from "remotion";

export interface VideoClipProps {
  src: string;
  startFrom?: number;
  endAt?: number;
  overlayColor?: string;
  overlayOpacity?: number;
  volume?: number;
  style?: React.CSSProperties;
}

export const VideoClip: React.FC<VideoClipProps> = ({
  src,
  startFrom,
  endAt,
  overlayColor,
  overlayOpacity = 0.4,
  volume = 0,
  style,
}) => {
  const resolvedSrc = src.startsWith("http") ? src : staticFile(src);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", ...style }}>
      <OffthreadVideo
        src={resolvedSrc}
        startFrom={startFrom}
        endAt={endAt}
        volume={volume}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
      {overlayColor && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: overlayColor,
            opacity: overlayOpacity,
          }}
        />
      )}
    </div>
  );
};
