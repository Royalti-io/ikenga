/**
 * Excalidraw types shared between Node.js scripts and Remotion components.
 *
 * Type-only file — no Node.js dependencies (no crypto, no fs).
 * Element builders remain in scripts/lib/excalidraw-elements.ts.
 */

// ── Core Element ────────────────────────────────────────────────────────────

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: null | Array<{ id: string; type: string }>;
  groupIds: string[];
  frameId: string | null;
  roundness: null | { type: number; value?: number };
  // Type-specific fields (text, arrows, lines, etc.)
  [key: string]: unknown;
}

// ── Document ────────────────────────────────────────────────────────────────

export interface ExcalidrawDocument {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: {
    viewBackgroundColor: string;
    gridSize: null;
    [key: string]: unknown;
  };
  files: Record<string, never>;
}

// ── Classified Elements (for animation ordering) ────────────────────────────

export type ElementCategory =
  | "frame"
  | "shape"
  | "text"
  | "arrow"
  | "line";

/** Classify an Excalidraw element for animation ordering. */
export function classifyElement(el: ExcalidrawElement): ElementCategory {
  switch (el.type) {
    case "frame":
      return "frame";
    case "text":
      return "text";
    case "arrow":
      return "arrow";
    case "line":
      return "line";
    case "rectangle":
    case "ellipse":
    case "diamond":
    default:
      return "shape";
  }
}

// ── Animation Group ─────────────────────────────────────────────────────────

/**
 * A logical group of elements that animate together as one "step".
 * Groups are formed by:
 * 1. Shared groupIds
 * 2. Shape + its bound text children
 * 3. Remaining shapes as singletons
 */
export interface AnimationGroup {
  /** Index for storyboard targeting (highlight_step, reveal_up_to). */
  index: number;
  /** Primary shape element (used for positioning). */
  shape: ExcalidrawElement;
  /** All elements in this group (shape + texts + decorations). */
  elements: ExcalidrawElement[];
}

/**
 * Group elements into animation steps.
 *
 * Strategy:
 * 1. Collect shapes (rect, ellipse, diamond) sorted by position (top-left to bottom-right)
 * 2. Attach bound text to parent shapes
 * 3. Each shape (+ its text) = one animation group
 * 4. Arrows/lines are not grouped — they animate separately based on endpoint visibility
 */
export function groupElements(elements: ExcalidrawElement[]): {
  groups: AnimationGroup[];
  arrows: ExcalidrawElement[];
  lines: ExcalidrawElement[];
  frames: ExcalidrawElement[];
  freeText: ExcalidrawElement[];
} {
  const shapes: ExcalidrawElement[] = [];
  const arrows: ExcalidrawElement[] = [];
  const lines: ExcalidrawElement[] = [];
  const frames: ExcalidrawElement[] = [];
  const texts: ExcalidrawElement[] = [];

  for (const el of elements) {
    if (el.isDeleted) continue;
    const cat = classifyElement(el);
    switch (cat) {
      case "frame":
        frames.push(el);
        break;
      case "shape":
        shapes.push(el);
        break;
      case "text":
        texts.push(el);
        break;
      case "arrow":
        arrows.push(el);
        break;
      case "line":
        lines.push(el);
        break;
    }
  }

  // Sort shapes by position: top-to-bottom, left-to-right.
  // ROW_QUANTIZE_PX bins shapes into rows so small vertical offsets
  // don't break reading order. 50px works for diagram-sketcher grids;
  // raw .excalidraw files with tighter layouts may need tuning.
  const ROW_QUANTIZE_PX = 50;
  shapes.sort((a, b) => {
    const rowDiff = Math.round(a.y / ROW_QUANTIZE_PX) - Math.round(b.y / ROW_QUANTIZE_PX);
    if (rowDiff !== 0) return rowDiff;
    return a.x - b.x;
  });

  // Build bound-text lookup: containerId → text element
  const boundTextMap = new Map<string, ExcalidrawElement[]>();
  const usedTextIds = new Set<string>();
  for (const t of texts) {
    const containerId = t.containerId as string | undefined;
    if (containerId) {
      const list = boundTextMap.get(containerId) ?? [];
      list.push(t);
      boundTextMap.set(containerId, list);
      usedTextIds.add(t.id);
    }
  }

  // Build groups: each shape + its bound text = one group
  const groups: AnimationGroup[] = shapes.map((shape, index) => {
    const boundTexts = boundTextMap.get(shape.id) ?? [];
    return {
      index,
      shape,
      elements: [shape, ...boundTexts],
    };
  });

  // Free text = text not bound to any shape
  const freeText = texts.filter((t) => !usedTextIds.has(t.id));

  return { groups, arrows, lines, frames, freeText };
}
