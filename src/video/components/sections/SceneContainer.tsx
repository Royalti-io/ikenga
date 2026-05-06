/**
 * SceneContainer — shared wrapper for all scene types.
 *
 * Provides a dark gradient background. In V2, beat subdivision is handled
 * by BeatSequence, so this is simplified to just a background wrapper.
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import { VIDEO_COLORS, BRAND } from "../../config/defaults";

interface SceneContainerProps {
  children: React.ReactNode;
}

export const SceneContainer: React.FC<SceneContainerProps> = ({
  children,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, ${VIDEO_COLORS.background} 0%, ${BRAND.gradientTo}22 100%)`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
