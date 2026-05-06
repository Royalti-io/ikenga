/**
 * AnnotatedImage — base image with timed annotation overlays.
 *
 * Vox Media style: "here's the document, and THIS is the part that matters"
 * with animated labels, arrows, highlights appearing timed to narration.
 *
 * Two modes:
 * - Overlay: Base image always visible, annotations appear on top
 * - Mask reveal: Dark background → image revealed via expanding mask,
 *   then annotations layer on top
 *
 * Uses the existing Callout component for annotation rendering.
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import { ImageReveal } from "./ImageReveal";
import { Callout, type CalloutStyle } from "../annotations/Callout";
import { VIDEO_COLORS } from "../../config/defaults";
/** Annotation overlay definition — label + position + optional style/color. */
export interface Annotation {
  /** Label text shown on the annotation. */
  label: string;
  /** X position as percentage (0-100). */
  x: number;
  /** Y position as percentage (0-100). */
  y: number;
  /** Visual style of the annotation callout. */
  style?: string;
  /** Accent color override. */
  color?: string;
}

export interface AnnotatedImageProps {
  /** Image source path (resolved via staticFile). */
  src: string;
  /** Annotation definitions from the script. */
  annotations: Annotation[];
  /** Indices of annotations currently revealed (driven by StoryboardRenderer). */
  revealedIndices: number[];
  /** If true, image starts hidden and reveals via mask when first annotation triggers. */
  maskReveal?: boolean;
  /** Image effect (from ImageReveal). */
  imageEffect?: "kenBurns" | "parallax" | "fade" | "zoomIn";
}

export const AnnotatedImage: React.FC<AnnotatedImageProps> = ({
  src,
  annotations,
  revealedIndices,
  maskReveal = false,
  imageEffect = "kenBurns",
}) => {
  const hasAnyRevealed = revealedIndices.length > 0;

  return (
    <AbsoluteFill>
      {/* Dark background (visible during mask reveal before image appears) */}
      {maskReveal && (
        <AbsoluteFill style={{ backgroundColor: VIDEO_COLORS.background }} />
      )}

      {/* Base image layer — hidden until first annotation in mask reveal mode */}
      <AbsoluteFill style={{ opacity: maskReveal && !hasAnyRevealed ? 0 : 1 }}>
        <ImageReveal
          src={src}
          effect={maskReveal ? "maskReveal" : imageEffect}
        />
      </AbsoluteFill>

      {/* Darkening overlay for better annotation readability */}
      {hasAnyRevealed && (
        <AbsoluteFill
          style={{
            background: "linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 100%)",
          }}
        />
      )}

      {/* Annotation overlays — each appears when its index is in revealedIndices */}
      {annotations.map((annotation, i) => {
        const isRevealed = revealedIndices.includes(i);
        if (!isRevealed) return null;

        return (
          <Callout
            key={i}
            x={annotation.x}
            y={annotation.y}
            label={annotation.label}
            calloutStyle={(annotation.style ?? "circle") as CalloutStyle}
            color={annotation.color}
            delay={0}
          />
        );
      })}
    </AbsoluteFill>
  );
};
