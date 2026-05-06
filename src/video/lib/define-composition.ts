/**
 * defineComposition() — self-registration pattern replacing per-composition
 * <Composition> JSX in Root.tsx.
 *
 * A composition file calls defineComposition() once at module scope. On
 * import, the call mutates a module-level registry. Root.tsx then calls
 * renderCompositions() to emit all registered <Composition> elements.
 *
 * Registration is idempotent: if the same `id` is registered twice (e.g.
 * during HMR), the second call silently replaces the first.
 *
 * TRANSITION NOTE (Phase 4):
 *   During the Phase 1→4 transition, Root.tsx renders BOTH the legacy manual
 *   <Composition> tags AND renderCompositions() output. Phase 4 will remove
 *   the legacy tags once their files are deleted. Duplicate ids between the
 *   two systems will cause Remotion to warn — keep composition ids unique.
 *
 * @example
 * // src/compositions/AskRoyClipVideo.tsx
 * defineComposition({
 *   id: "AskRoyClip",
 *   component: AskRoyClipVideo,
 *   fps: 30,
 *   width: 1080,
 *   height: 1920,
 *   durationInFrames: 1361,
 *   defaultProps: { narrationFile: "ask-roy/narration.mp3", screenshotFile: "ask-roy/audit-story.png" },
 *   beats: askRoyBeats,
 *   narrationFile: "ask-roy/narration.mp3",
 * });
 */

import React from "react";
import { Composition } from "remotion";
import type { Beat } from "./define-beats";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CompositionDefinition {
  /** Remotion composition id — must be globally unique across all compositions. */
  id: string;
  /** The React component to render. */
  component: React.FC<any>;
  /** Frames per second. */
  fps: number;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /**
   * Total duration in frames. Either this OR `calculateMetadata` must be
   * provided. If both are provided, `calculateMetadata` wins at render time
   * (this value is used as a placeholder in Studio).
   */
  durationInFrames: number;
  /** Default prop values shown in Remotion Studio prop editor. */
  defaultProps: Record<string, unknown>;

  // ── Optional metadata for storyboard app ────────────────────────────────
  /** Beat timeline for this composition (from defineBeats()). */
  beats?: Beat[];
  /** Path to the narration audio (relative to public/). */
  narrationFile?: string;

  // ── Optional Remotion features ───────────────────────────────────────────
  /** Zod schema for interactive Studio prop editing. */
  schema?: unknown;
  /** Async metadata resolver. Replaces durationInFrames + static dims. */
  calculateMetadata?: (args: { props: any }) => Promise<any>;
  /** Folder name in Remotion Studio sidebar. */
  folder?: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

/** Module-level registry — mutated by defineComposition(), read by renderCompositions(). */
const _registry = new Map<string, CompositionDefinition>();

/**
 * Register a composition. Idempotent: calling with the same `id` replaces
 * the prior entry (safe for HMR / double-import scenarios).
 */
export function defineComposition(def: CompositionDefinition): void {
  _registry.set(def.id, def);
}

/**
 * Return all registered definitions in registration order.
 * Called by Root.tsx; not typically called by composition files.
 */
export function getRegistry(): CompositionDefinition[] {
  return Array.from(_registry.values());
}

/**
 * Render all registered compositions as Remotion <Composition> elements.
 * Compositions registered with a `folder` will appear inside a Remotion
 * <Folder> in Studio. Without a folder, they appear at the root level.
 *
 * Call this inside RemotionRoot:
 *   export const RemotionRoot = () => <>{renderCompositions()}</>;
 */
export function renderCompositions(): React.ReactElement[] {
  return Array.from(_registry.values()).map((def) => {
    const props: Record<string, unknown> = {
      key: def.id,
      id: def.id,
      component: def.component,
      fps: def.fps,
      width: def.width,
      height: def.height,
      durationInFrames: def.durationInFrames,
      defaultProps: def.defaultProps,
    };

    if (def.schema) props["schema"] = def.schema;
    if (def.calculateMetadata) props["calculateMetadata"] = def.calculateMetadata;

    return React.createElement(Composition, props as any);
  });
}

/**
 * Reset the registry. Used in tests only — do not call in production code.
 * @internal
 */
export function _resetRegistryForTests(): void {
  _registry.clear();
}
