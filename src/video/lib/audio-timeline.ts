import { DEFAULT_SECTION_GAP_FRAMES, DEFAULT_PADDING_FRAMES } from "../config/defaults";

// ── Voiceover Manifest Types ────────────────────────────────────────────────
// These match the manifest written by scripts/generate-voiceover.ts

export interface VoiceoverManifestSection {
  id: string;
  title: string;
  file: string;
  text: string;
  durationSec: number;
  characterTimestamps?: Array<{ character: string; startSec: number; endSec: number }>;
}

export interface VoiceoverManifest {
  slug: string;
  generatedAt: string;
  voiceId: string;
  model: string;
  sections: VoiceoverManifestSection[];
  totalDurationSec: number;
}

// ── Timeline Types ──────────────────────────────────────────────────────────

export interface TimelineEntry {
  sectionId: string;
  startFrame: number;
  endFrame: number;
  file: string;
  durationSec: number;
}

// ── Frame / Second Conversion ───────────────────────────────────────────────

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

// ── Timeline Builder ────────────────────────────────────────────────────────

/**
 * Build a frame-accurate voiceover timeline from a manifest.
 *
 * Each section is placed sequentially with `gapFrames` silence between entries.
 * Default gap is 15 frames (0.5 s at 30 fps).
 */
export function buildVoiceoverTimeline(
  manifest: VoiceoverManifest,
  fps: number,
  gapFrames: number = DEFAULT_SECTION_GAP_FRAMES,
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let cursor = 0;

  for (const section of manifest.sections) {
    const durationFrames = secondsToFrames(section.durationSec, fps);
    const startFrame = cursor;
    const endFrame = startFrame + durationFrames;

    timeline.push({
      sectionId: section.id,
      startFrame,
      endFrame,
      file: section.file,
      durationSec: section.durationSec,
    });

    cursor = endFrame + gapFrames;
  }

  return timeline;
}

// ── Frame Query ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the given frame falls inside any voiceover section.
 */
export function isVoiceActiveAtFrame(frame: number, timeline: TimelineEntry[]): boolean {
  for (const entry of timeline) {
    if (frame >= entry.startFrame && frame < entry.endFrame) {
      return true;
    }
  }
  return false;
}

// ── Total Duration ──────────────────────────────────────────────────────────

/**
 * Calculate the total composition length in frames.
 *
 * Builds the timeline, takes the last entry's endFrame, and adds
 * `paddingFrames` (default 90 — 3 s at 30 fps) for an outro buffer.
 */
export function calculateTotalDuration(
  manifest: VoiceoverManifest,
  fps: number,
  paddingFrames: number = DEFAULT_PADDING_FRAMES,
): number {
  const timeline = buildVoiceoverTimeline(manifest, fps);

  if (timeline.length === 0) {
    return paddingFrames;
  }

  const lastEntry = timeline[timeline.length - 1];
  return lastEntry.endFrame + paddingFrames;
}

// ── Animation → SFX Mapping ────────────────────────────────────────────────

/**
 * Maps animation pattern names to their corresponding SFX names
 * from the SFX library (see scripts/generate-sfx-library.ts).
 *
 * Note: `ambient-loop` is intentionally excluded — it is a continuous
 * background layer, not an animation-triggered sound effect.
 */

/** Animation pattern names that have SFX mappings. */
export type AnimationType =
  | "fadeInScale"
  | "springPopIn"
  | "sectionTransition"
  | "drawLine"
  | "typewriter"
  | "dataReveal"
  | "slideIn"
  | "successChime"
  | "outroResolve";

/** SFX names available in the library. */
export type SfxName =
  | "title-fade-in"
  | "icon-pop-in"
  | "section-transition"
  | "diagram-draw"
  | "text-typewriter"
  | "data-reveal"
  | "slide-in"
  | "success-chime"
  | "outro-resolve";

export const ANIMATION_SFX_MAP: Record<AnimationType, SfxName> = {
  fadeInScale: "title-fade-in",
  springPopIn: "icon-pop-in",
  sectionTransition: "section-transition",
  drawLine: "diagram-draw",
  typewriter: "text-typewriter",
  dataReveal: "data-reveal",
  slideIn: "slide-in",
  successChime: "success-chime",
  outroResolve: "outro-resolve",
};
