import { ANIMATION_SFX_MAP, type AnimationType, type SfxName } from "./audio-timeline";

// ── SFX Manifest Types ──────────────────────────────────────────────────────
// These match the manifest written by scripts/generate-sfx-library.ts

export interface SfxManifestEntry {
  name: string;
  file: string;
  durationSec: number;
  loop: boolean;
  prompt: string;
}

export interface SfxManifest {
  generatedAt: string;
  promptInfluence: number;
  effects: SfxManifestEntry[];
}

// ── Module Cache ────────────────────────────────────────────────────────────

let cachedManifest: SfxManifest | null = null;

/**
 * Provide the SFX manifest data so the registry can serve look-ups.
 *
 * Call this once at composition init time — for example in a Remotion
 * `calculateMetadata` callback — before any component calls the
 * getter helpers below.
 */
export function setSfxManifest(manifest: SfxManifest): void {
  cachedManifest = manifest;
}

function getManifest(): SfxManifest {
  if (!cachedManifest) {
    throw new Error(
      "SFX manifest not loaded. Call setSfxManifest() first, or pass manifest via props.",
    );
  }
  return cachedManifest;
}

// ── Look-up Helpers ─────────────────────────────────────────────────────────

/**
 * Get the duration (in seconds) of an SFX by its name.
 */
export function getSfxDuration(sfxName: string): number {
  const manifest = getManifest();
  const entry = manifest.effects.find((e) => e.name === sfxName);
  if (!entry) {
    throw new Error(`SFX not found: "${sfxName}". Available: ${manifest.effects.map((e) => e.name).join(", ")}`);
  }
  return entry.durationSec;
}

/**
 * Get the filename of an SFX by its name.
 */
export function getSfxFile(sfxName: string): string {
  const manifest = getManifest();
  const entry = manifest.effects.find((e) => e.name === sfxName);
  if (!entry) {
    throw new Error(`SFX not found: "${sfxName}". Available: ${manifest.effects.map((e) => e.name).join(", ")}`);
  }
  return entry.file;
}

/**
 * Resolve an animation pattern name to its mapped SFX name.
 *
 * Returns `null` when no mapping exists for the given animation type.
 */
export function getSfxForAnimation(animationType: string): SfxName | null {
  if (animationType in ANIMATION_SFX_MAP) {
    return ANIMATION_SFX_MAP[animationType as AnimationType];
  }
  return null;
}
