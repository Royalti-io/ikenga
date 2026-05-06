/**
 * Centralized configuration for the Royalti Video Engine.
 *
 * All magic numbers, brand colors, and dimension presets live here.
 * Import from '@/config/defaults' instead of hard-coding values.
 */

// ── Video Dimensions ───────────────────────────────────────────────────────

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Aspect ratio presets for different output formats. */
export const ASPECT_RATIOS = {
  LANDSCAPE: { width: 1920, height: 1080 },
  PORTRAIT: { width: 1080, height: 1920 },
  SQUARE: { width: 1080, height: 1080 },
} as const;

// ── Audio ──────────────────────────────────────────────────────────────────

/** Frames of crossfade when ducking transitions between states. */
export const DUCKING_TRANSITION_FRAMES = 5;

/** Silence gap between sequential voiceover sections. */
export const DEFAULT_SECTION_GAP_FRAMES = 15;

/** Padding after last voiceover section before video ends. */
export const DEFAULT_PADDING_FRAMES = 90;

/** Background music volume when voice is NOT active. */
export const MUSIC_VOLUME = 0.4;

/** Background music volume when voice IS active (ducked). */
export const DUCKED_VOLUME = 0.15;

/** SFX volume when voice IS active (ducked). */
export const SFX_DUCKED_VOLUME = 0.35;

// ── Brand Colors ───────────────────────────────────────────────────────────
//
// Canonical source: Pencil design system (royalti-client.pen)
// Last synced: 2026-03-22
//
// Video-specific overrides use dark mode values since videos have dark backgrounds.

export const BRAND = {
  /** Pencil --primary (same in light/dark) */
  primary: "#006666",

  /** Pencil --foreground (light mode) */
  foreground: "#0A0F1A",

  /** Pencil --background (light mode) */
  background: "#FFFFFF",

  /** Pencil --muted-foreground (light mode) */
  muted: "#6B7B8D",

  /** Pencil --success */
  success: "#10B981",

  /** Pencil --warning */
  warning: "#F59E0B",

  /** Pencil --info */
  info: "#3B82F6",

  /** Pencil --primary-gradient-from */
  gradientFrom: "#2A7B7B",

  /** Pencil --primary-gradient-to */
  gradientTo: "#006666",

  /** Chart colors from Pencil */
  chart: [
    "#10B981", "#1F84F2", "#F59E0B", "#8B5CF6",
    "#EC4899", "#06B6D4", "#F97316", "#64748B",
  ],
} as const;

/**
 * Video-specific colors (dark mode).
 * Videos always render on dark backgrounds, so we use Pencil dark-mode values.
 */
export const VIDEO_COLORS = {
  /** Pencil dark --background */
  background: "#0D0D0D",

  /** Pencil dark --foreground */
  text: "#F8FAFC",

  /** Pencil dark --muted-foreground */
  mutedText: "#8899AA",

  /** Pencil dark --border */
  border: "#1F1F1F",

  /** Same as BRAND */
  primary: BRAND.primary,
  success: BRAND.success,
  warning: BRAND.warning,
  info: BRAND.info,
} as const;

// ── Typography ─────────────────────────────────────────────────────────────
//
// Font: Plus Jakarta Sans (from Pencil --font-primary)
// Loaded via @remotion/google-fonts in compositions.
// Replaces previous hard-coded "Inter".

export const FONT = {
  /** Primary font family (Pencil --font-primary) */
  family: "Plus Jakarta Sans",

  /** Fallback stack */
  fallback: "Plus Jakarta Sans, system-ui, -apple-system, sans-serif",

  /** Default title size */
  titleSize: 64,

  /** Default body size */
  bodySize: 32,

  /** Default code size */
  codeSize: 24,
} as const;

// ── Animation Spring Configs ──────────────────────────────────────────────
//
// Shared spring presets used by animation hooks and diagram components.
// Each maps to a common motion feel — components pick the appropriate preset.

export const SPRING_CONFIGS = {
  /** Rows, cards, smooth entries. damping: 18, stiffness: 90 */
  GENTLE: { damping: 18, stiffness: 90 },
  /** Nodes, cells, crisp entries. damping: 15, stiffness: 120 */
  SNAPPY: { damping: 15, stiffness: 120 },
  /** Dots, spokes, playful bounce. damping: 10, stiffness: 150, mass: 0.5 */
  BOUNCY: { damping: 10, stiffness: 150, mass: 0.5 },
  /** Bars, slow reveals. damping: 20, stiffness: 80 */
  SLOW: { damping: 20, stiffness: 80 },
} as const;

export type SpringConfigName = keyof typeof SPRING_CONFIGS;
