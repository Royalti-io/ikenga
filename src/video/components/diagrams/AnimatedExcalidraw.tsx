/**
 * AnimatedExcalidraw — renders Excalidraw elements as animated SVG in Remotion.
 *
 * Replaces the static PNG rendering of `excalidraw_diagram` visual type.
 * Uses roughjs for hand-drawn style (roughness > 0) and clean SVG for roughness=0.
 *
 * Animation ordering:
 * 1. Frames (instant, z-behind)
 * 2. Shape groups (staggered spring entrance)
 * 3. Bound text (fades in with parent shape)
 * 4. Arrows/lines (stroke-dashoffset draw after connected shapes visible)
 * 5. Free text (staggered after shapes)
 *
 * Storyboard integration:
 * - visibleCount: progressive reveal of shape groups
 * - highlightIndex: glow pulse on a specific group
 */

import React, { useId, useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import rough from "roughjs/bin/rough";
import type { ExcalidrawElement } from "../../lib/excalidraw-types";
import { groupElements } from "../../lib/excalidraw-types";
import { useStaggeredReveal } from "../../hooks/useStaggeredReveal";
import { useLineDrawSVG } from "../../hooks/useLineDrawSVG";
import { SPRING_CONFIGS, VIDEO_COLORS } from "../../config/defaults";
import { fontFamily } from "../../config/fonts";

// ── RoughShape path cache ──────────────────────────────────────────────────
// Module-scoped cache for roughjs-generated SVG paths. The rough generator is
// deterministic (seeded by el.seed), so identical inputs always produce
// identical paths. Keyed by "id:version:roughness" to invalidate on edits.
type RoughPathEntry = {
  d: string;
  type: string;
  stroke: string;
  fill: string | undefined;
  strokeWidth: number;
};
const roughPathCache = new Map<string, RoughPathEntry[]>();

// ── Props ───────────────────────────────────────────────────────────────────

export interface AnimatedExcalidrawProps {
  /** Pre-computed ExcalidrawElement[] from diagram-sketcher or .excalidraw file. */
  elements: ExcalidrawElement[];
  /** Color theme. */
  theme?: "light" | "dark";
  /** Roughness: 0=clean SVG, 1=sketchy, 2=rough. */
  roughness?: number;
  /** Delay before animation starts (frames). */
  delay?: number;
  /** Canvas dimensions (default: video dimensions). */
  canvasWidth?: number;
  canvasHeight?: number;
  /** V3: Show only first N shape groups (progressive reveal). */
  visibleCount?: number;
  /** V3: Highlight a specific group with glow pulse. -1 = none. */
  highlightIndex?: number;
  /** Frame at which highlight starts. */
  highlightAt?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SHAPE_STAGGER = 8; // frames between each shape group
const ARROW_DELAY = 12; // frames after last shape before arrows draw
const ARROW_DRAW_FRAMES = 18; // duration of arrow draw animation
const TEXT_FADE_FRAMES = 10; // text fade-in duration
const HIGHLIGHT_GLOW_SIZE = 8; // px of highlight glow

// ── Component ───────────────────────────────────────────────────────────────

export const AnimatedExcalidraw = React.memo<AnimatedExcalidrawProps>(({
  elements,
  theme = "dark",
  roughness = 1,
  delay = 0,
  canvasWidth: canvasWidthProp,
  canvasHeight: canvasHeightProp,
  visibleCount,
  highlightIndex = -1,
  highlightAt = 60,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const instanceId = useId();

  const canvasWidth = canvasWidthProp ?? width;
  const canvasHeight = canvasHeightProp ?? height;

  // Group elements for animation
  const classified = useMemo(() => groupElements(elements), [elements]);
  const { groups, arrows, lines, frames: frameEls, freeText } = classified;

  // Effective groups based on visibleCount
  const effectiveGroups =
    visibleCount != null ? groups.slice(0, visibleCount) : groups;

  // Staggered reveal for shape groups
  const shapeReveal = useStaggeredReveal({
    count: effectiveGroups.length,
    stagger: SHAPE_STAGGER,
    delay,
    springConfig: SPRING_CONFIGS.SNAPPY,
  });

  // Arrow animation starts after all shapes have entered
  const arrowStartFrame =
    delay + effectiveGroups.length * SHAPE_STAGGER + ARROW_DELAY;

  // Compute bounding box for viewport
  const viewBox = useMemo(() => {
    if (elements.length === 0) return { x: 0, y: 0, w: canvasWidth, h: canvasHeight };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      if (el.isDeleted) continue;
      // Handle arrow/line point offsets
      const pts = el.points as Array<[number, number]> | undefined;
      if (pts && pts.length > 0) {
        for (const [px, py] of pts) {
          minX = Math.min(minX, el.x + px);
          minY = Math.min(minY, el.y + py);
          maxX = Math.max(maxX, el.x + px);
          maxY = Math.max(maxY, el.y + py);
        }
      } else {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + el.width);
        maxY = Math.max(maxY, el.y + el.height);
      }
    }
    const pad = 60;
    return {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    };
  }, [elements, canvasWidth, canvasHeight]);

  // Scale to fit canvas
  const scale = Math.min(canvasWidth / viewBox.w, canvasHeight / viewBox.h);
  const offsetX = (canvasWidth - viewBox.w * scale) / 2 - viewBox.x * scale;
  const offsetY = (canvasHeight - viewBox.h * scale) / 2 - viewBox.y * scale;

  // Highlight animation
  const highlightProgress =
    highlightIndex >= 0
      ? spring({
          frame: Math.max(0, frame - highlightAt),
          fps,
          config: { damping: 8, stiffness: 100 },
        })
      : 0;

  const glowFilterId = `glow-${instanceId}`;

  return (
    <AbsoluteFill
      style={{ backgroundColor: theme === "dark" ? VIDEO_COLORS.background : "#ffffff" }}
    >
      <svg
        viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
        width={canvasWidth}
        height={canvasHeight}
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        <g transform={`translate(${offsetX}, ${offsetY}) scale(${scale})`}>
          {/* Layer 1: Frames (instant, background) */}
          {frameEls.map((el) => (
            <RenderShape key={el.id} element={el} opacity={1} roughness={0} />
          ))}

          {/* Layer 2: Shape groups (staggered reveal) */}
          {effectiveGroups.map((group, i) => {
            const opacity = shapeReveal.getItemOpacity(i);
            const scaleVal = shapeReveal.getItemScale(i, 0.85);
            const translateY = shapeReveal.getItemTranslateY(i, 15);
            const isHighlighted = i === highlightIndex;

            // Center of the group shape for transform origin
            const cx = group.shape.x + group.shape.width / 2;
            const cy = group.shape.y + group.shape.height / 2;

            return (
              <g
                key={`group-${group.index}`}
                style={{ opacity }}
                transform={`translate(${cx}, ${cy + translateY}) scale(${scaleVal}) translate(${-cx}, ${-cy})`}
              >
                {/* Highlight glow */}
                {isHighlighted && highlightProgress > 0 && (
                  <rect
                    x={group.shape.x - HIGHLIGHT_GLOW_SIZE}
                    y={group.shape.y - HIGHLIGHT_GLOW_SIZE}
                    width={group.shape.width + HIGHLIGHT_GLOW_SIZE * 2}
                    height={group.shape.height + HIGHLIGHT_GLOW_SIZE * 2}
                    rx={12}
                    fill="none"
                    stroke={VIDEO_COLORS.primary}
                    strokeWidth={3}
                    opacity={interpolate(highlightProgress, [0, 0.5, 1], [0, 0.8, 0.6])}
                    filter={`url(#${glowFilterId})`}
                  />
                )}
                {/* Shape + bound text */}
                {group.elements.map((el) =>
                  el.type === "text" ? (
                    <RenderText key={el.id} element={el} opacity={opacity} />
                  ) : (
                    <RenderShape
                      key={el.id}
                      element={el}
                      opacity={1}
                      roughness={roughness}
                    />
                  ),
                )}
              </g>
            );
          })}

          {/* Layer 3: Lines (draw animation) */}
          {lines.map((el, i) => (
            <AnimatedLine
              key={el.id}
              element={el}
              delay={arrowStartFrame + i * 5}
              durationFrames={ARROW_DRAW_FRAMES}
            />
          ))}

          {/* Layer 4: Arrows (draw animation after shapes) */}
          {arrows.map((el, i) => (
            <AnimatedArrow
              key={el.id}
              element={el}
              delay={arrowStartFrame + (lines.length + i) * 5}
              durationFrames={ARROW_DRAW_FRAMES}
            />
          ))}

          {/* Layer 5: Free text (fade in after shapes) */}
          {freeText.map((el, i) => {
            const textDelay =
              arrowStartFrame + (lines.length + arrows.length) * 5 + i * 5;
            const progress = interpolate(
              frame - textDelay,
              [0, TEXT_FADE_FRAMES],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            );
            return (
              <RenderText key={el.id} element={el} opacity={progress} />
            );
          })}
        </g>

        {/* SVG filters */}
        <defs>
          <filter id={glowFilterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
    </AbsoluteFill>
  );
});

// ── Sub-components ──────────────────────────────────────────────────────────

/** Render a shape element (rectangle, ellipse, diamond) as SVG. */
const RenderShape: React.FC<{
  element: ExcalidrawElement;
  opacity: number;
  roughness: number;
}> = ({ element: el, opacity, roughness }) => {
  const fill = el.backgroundColor === "transparent" ? "none" : el.backgroundColor;
  const stroke = el.strokeColor;
  const sw = el.strokeWidth;
  const rx = el.roundness?.type === 3 ? Math.min(12, el.width * 0.1) : 0;

  if (roughness === 0) {
    // Clean SVG rendering
    switch (el.type) {
      case "rectangle":
      case "frame":
        return (
          <rect
            x={el.x}
            y={el.y}
            width={el.width}
            height={el.height}
            rx={rx}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            opacity={opacity}
            strokeDasharray={el.strokeStyle === "dashed" ? "12 6" : el.strokeStyle === "dotted" ? "4 4" : undefined}
          />
        );
      case "ellipse":
        return (
          <ellipse
            cx={el.x + el.width / 2}
            cy={el.y + el.height / 2}
            rx={el.width / 2}
            ry={el.height / 2}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            opacity={opacity}
          />
        );
      case "diamond": {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        return (
          <polygon
            points={`${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}`}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            opacity={opacity}
          />
        );
      }
      default:
        return (
          <rect
            x={el.x}
            y={el.y}
            width={el.width}
            height={el.height}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            opacity={opacity}
          />
        );
    }
  }

  // Rough (hand-drawn) rendering via roughjs SVG path generation
  return (
    <RoughShape element={el} opacity={opacity} roughness={roughness} />
  );
};

/**
 * Hand-drawn shape using roughjs.
 * Generates SVG path strings at render time using the rough generator.
 */
const RoughShape: React.FC<{
  element: ExcalidrawElement;
  opacity: number;
  roughness: number;
}> = ({ element: el, opacity, roughness }) => {
  const paths = useMemo(() => {
    const cacheKey = `${el.id}:${el.version}:${roughness}`;
    const cached = roughPathCache.get(cacheKey);
    if (cached) return cached;

    const rc = rough.generator();
    const fill = el.backgroundColor === "transparent" ? undefined : el.backgroundColor;
    const opts = {
      stroke: el.strokeColor,
      strokeWidth: el.strokeWidth,
      fill,
      fillStyle: el.fillStyle === "solid" ? "solid" as const : "hachure" as const,
      roughness: roughness * 1.2,
      seed: el.seed,
    };

    let drawable;
    switch (el.type) {
      case "rectangle":
      case "frame":
        drawable = rc.rectangle(el.x, el.y, el.width, el.height, opts);
        break;
      case "ellipse":
        drawable = rc.ellipse(
          el.x + el.width / 2,
          el.y + el.height / 2,
          el.width,
          el.height,
          opts,
        );
        break;
      case "diamond": {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        drawable = rc.polygon(
          [
            [cx, el.y],
            [el.x + el.width, cy],
            [cx, el.y + el.height],
            [el.x, cy],
          ],
          opts,
        );
        break;
      }
      default:
        drawable = rc.rectangle(el.x, el.y, el.width, el.height, opts);
    }

    // Extract SVG path data from roughjs drawable
    const result: RoughPathEntry[] = drawable.sets.map((set) => ({
      d: rc.opsToPath(set),
      type: set.type,
      stroke: opts.stroke,
      fill: opts.fill,
      strokeWidth: opts.strokeWidth,
    }));

    roughPathCache.set(cacheKey, result);
    return result;
  }, [el, roughness]);

  return (
    <g opacity={opacity}>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.type === "fillSketch" || p.type === "fillPath" ? (p.fill ?? "none") : "none"}
          stroke={p.type === "fillSketch" || p.type === "fillPath" ? (p.fill ?? p.stroke) : p.stroke}
          strokeWidth={p.type === "fillSketch" ? p.strokeWidth * 0.5 : p.strokeWidth}
        />
      ))}
    </g>
  );
};

/** Render a text element as SVG <text>. */
const RenderText: React.FC<{
  element: ExcalidrawElement;
  opacity: number;
}> = ({ element: el, opacity }) => {
  const text = (el.text as string) ?? "";
  const fontSize = (el.fontSize as number) ?? 20;
  const textAlign = (el.textAlign as string) ?? "left";
  const color = el.strokeColor;
  const isMonospace = (el.fontFamily as number) === 3;

  const lines = text.split("\n");
  const lineHeight = fontSize * 1.4;

  // Anchor mapping
  const anchor =
    textAlign === "center" ? "middle" : textAlign === "right" ? "end" : "start";
  const xOffset =
    textAlign === "center"
      ? el.width / 2
      : textAlign === "right"
        ? el.width
        : 0;

  return (
    <g opacity={opacity}>
      {lines.map((line, i) => (
        <text
          key={i}
          x={el.x + xOffset}
          y={el.y + fontSize + i * lineHeight}
          fill={color}
          fontSize={fontSize}
          fontFamily={isMonospace ? "JetBrains Mono, monospace" : fontFamily}
          textAnchor={anchor}
          dominantBaseline="auto"
        >
          {line}
        </text>
      ))}
    </g>
  );
};

/**
 * Build an SVG path string from Excalidraw points, supporting both straight
 * segments and smooth bezier curves (when roundness type === 2).
 */
function buildPathD(
  pts: Array<[number, number]>,
  originX: number,
  originY: number,
  roundness: { type: number } | null,
): string {
  const isCurved =
    roundness !== null && roundness.type === 2 && pts.length >= 3;

  if (!isCurved) {
    // Straight-line segments (original behavior)
    return pts
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"} ${originX + p[0]} ${originY + p[1]}`,
      )
      .join(" ");
  }

  // Catmull-Rom style smooth bezier curves:
  //   First segment:  M p0 Q p1 mid(p1,p2)
  //   Middle segments: Q pi mid(pi, pi+1)
  //   Last segment:   Q p(n-1) pn
  const px = (i: number) => originX + pts[i][0];
  const py = (i: number) => originY + pts[i][1];
  const mid = (a: number, b: number) => (a + b) / 2;

  let d = `M ${px(0)} ${py(0)}`;

  // First segment: quadratic to midpoint between p1 and p2
  d += ` Q ${px(1)} ${py(1)} ${mid(px(1), px(2))} ${mid(py(1), py(2))}`;

  // Middle segments
  for (let i = 2; i < pts.length - 1; i++) {
    d += ` Q ${px(i)} ${py(i)} ${mid(px(i), px(i + 1))} ${mid(py(i), py(i + 1))}`;
  }

  // Last segment: quadratic to final point
  const last = pts.length - 1;
  d += ` Q ${px(last - 1)} ${py(last - 1)} ${px(last)} ${py(last)}`;

  return d;
}

/** Animated arrow with stroke-dashoffset draw effect + arrowhead. */
const AnimatedArrow: React.FC<{
  element: ExcalidrawElement;
  delay: number;
  durationFrames: number;
}> = ({ element: el, delay: arrowDelay, durationFrames }) => {
  const pts = (el.points as Array<[number, number]>) ?? [];
  if (pts.length < 2) return null;

  // Build SVG path from points (curved when roundness type 2)
  const pathD = buildPathD(
    pts,
    el.x,
    el.y,
    el.roundness as { type: number } | null,
  );

  // Estimate total path length
  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }

  const lineDraw = useLineDrawSVG({
    totalLength,
    delay: arrowDelay,
    durationFrames,
  });

  // Arrowheads
  const endArrowhead = el.endArrowhead as string | null;
  const startArrowhead = el.startArrowhead as string | null;
  const headSize = 10;

  // End arrowhead geometry
  const lastPt = pts[pts.length - 1];
  const prevPt = pts[pts.length - 2];
  const endAngle = Math.atan2(
    lastPt[1] - prevPt[1],
    lastPt[0] - prevPt[0],
  );
  const endX = el.x + lastPt[0];
  const endY = el.y + lastPt[1];

  // Start arrowhead geometry (points backward along the first segment)
  const firstPt = pts[0];
  const secondPt = pts[1];
  const startAngle = Math.atan2(
    firstPt[1] - secondPt[1],
    firstPt[0] - secondPt[0],
  );
  const startX = el.x + firstPt[0];
  const startY = el.y + firstPt[1];

  return (
    <g>
      <path
        d={pathD}
        fill="none"
        stroke={el.strokeColor}
        strokeWidth={el.strokeWidth}
        strokeDasharray={lineDraw.strokeDasharray}
        strokeDashoffset={lineDraw.strokeDashoffset}
      />
      {/* Start arrowhead — appears early in draw */}
      {startArrowhead === "arrow" && lineDraw.progress > 0.1 && (
        <polygon
          points={`
            ${startX},${startY}
            ${startX - headSize * Math.cos(startAngle - Math.PI / 6)},${startY - headSize * Math.sin(startAngle - Math.PI / 6)}
            ${startX - headSize * Math.cos(startAngle + Math.PI / 6)},${startY - headSize * Math.sin(startAngle + Math.PI / 6)}
          `}
          fill={el.strokeColor}
          opacity={interpolate(lineDraw.progress, [0.1, 0.3], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
      )}
      {/* End arrowhead — appears when line is mostly drawn */}
      {endArrowhead === "arrow" && lineDraw.progress > 0.8 && (
        <polygon
          points={`
            ${endX},${endY}
            ${endX - headSize * Math.cos(endAngle - Math.PI / 6)},${endY - headSize * Math.sin(endAngle - Math.PI / 6)}
            ${endX - headSize * Math.cos(endAngle + Math.PI / 6)},${endY - headSize * Math.sin(endAngle + Math.PI / 6)}
          `}
          fill={el.strokeColor}
          opacity={interpolate(lineDraw.progress, [0.8, 1], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
      )}
    </g>
  );
};

/** Animated line with stroke-dashoffset draw effect. */
const AnimatedLine: React.FC<{
  element: ExcalidrawElement;
  delay: number;
  durationFrames: number;
}> = ({ element: el, delay: lineDelay, durationFrames }) => {
  const pts = (el.points as Array<[number, number]>) ?? [];
  if (pts.length < 2) return null;

  const pathD = buildPathD(
    pts,
    el.x,
    el.y,
    el.roundness as { type: number } | null,
  );

  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }

  const lineDraw = useLineDrawSVG({
    totalLength,
    delay: lineDelay,
    durationFrames,
  });

  return (
    <path
      d={pathD}
      fill="none"
      stroke={el.strokeColor}
      strokeWidth={el.strokeWidth}
      strokeDasharray={lineDraw.strokeDasharray}
      strokeDashoffset={lineDraw.strokeDashoffset}
    />
  );
};
