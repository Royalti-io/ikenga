/**
 * Semantic Color Palette — single source of truth for all video engine colors.
 *
 * Aligned with .company/brand/design-tokens.json and Pencil design system.
 * Used by: diagram components, AnimatedExcalidraw, diagram-sketcher themes.
 *
 * Each role has a fill (lighter) + stroke (darker) pair for consistent styling.
 * Inspired by coleam00/excalidraw-diagram-skill color palette pattern.
 */

// ── Semantic Color Pairs ────────────────────────────────────────────────────

export interface ColorPair {
  fill: string;
  stroke: string;
}

/** 10 semantic color roles for diagrams and visuals. */
export const SEMANTIC_COLORS = {
  /** Primary brand teal — main accents, highlights */
  primary: { fill: "#1a3a4a", stroke: "#006666" },

  /** Secondary green — positive, growth */
  secondary: { fill: "#1a3a2a", stroke: "#009d73" },

  /** Success — achievement, completion */
  success: { fill: "#1a3a2a", stroke: "#10B981" },

  /** Warning — caution, attention */
  warning: { fill: "#3a3020", stroke: "#F59E0B" },

  /** Info — informational, neutral highlight */
  info: { fill: "#1a2a3a", stroke: "#3B82F6" },

  /** Error/Danger — problems, missing data */
  error: { fill: "#3a1a1a", stroke: "#EF4444" },

  /** AI/LLM — machine learning, automation */
  ai: { fill: "#2a1a3a", stroke: "#8B5CF6" },

  /** Start/Trigger — entry points, initiators */
  start: { fill: "#1a3a3a", stroke: "#06B6D4" },

  /** Inactive/Muted — disabled, background */
  inactive: { fill: "#1a1a1a", stroke: "#495057" },

  /** Accent — emphasis, call-to-action */
  accent: { fill: "#3a2a1a", stroke: "#F97316" },
} as const satisfies Record<string, ColorPair>;

export type SemanticColorRole = keyof typeof SEMANTIC_COLORS;

// ── Text Hierarchy ──────────────────────────────────────────────────────────

export const TEXT_COLORS = {
  /** Titles, headings */
  title: "#F8FAFC",
  /** Subtitles, secondary headings */
  subtitle: "#CBD5E1",
  /** Body text, descriptions */
  body: "#8899AA",
  /** On light backgrounds */
  onLight: "#1E293B",
  /** On dark backgrounds (same as title) */
  onDark: "#F8FAFC",
  /** Code/JSON evidence */
  code: "#E2E8F0",
  /** Muted labels */
  muted: "#64748B",
} as const;

// ── Excalidraw Theme Colors ─────────────────────────────────────────────────
// Used by diagram-sketcher.ts and AnimatedExcalidraw.tsx

export interface ExcalidrawThemeColors {
  bg: string;
  boxFill: string;
  boxStroke: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  muted: string;
}

export const EXCALIDRAW_THEMES: Record<"light" | "dark", ExcalidrawThemeColors> = {
  light: {
    bg: "#ffffff",
    boxFill: "#d0ebff",
    boxStroke: "#1971c2",
    textPrimary: "#1864ab",
    textSecondary: "#495057",
    accent: "#4dabf7",
    muted: "#ced4da",
  },
  dark: {
    bg: "#0D0D0D",
    boxFill: SEMANTIC_COLORS.primary.fill,
    boxStroke: "#4dabf7",
    textPrimary: "#a5d8ff",
    textSecondary: "#adb5bd",
    accent: SEMANTIC_COLORS.primary.stroke,
    muted: SEMANTIC_COLORS.inactive.stroke,
  },
};

// ── Diagram Highlight Colors ────────────────────────────────────────────────
// Used by FlowChart, HubSpoke, StatGrid for glow/pulse effects

export const HIGHLIGHT_COLORS = {
  /** Glow ring color for highlighted elements */
  glow: SEMANTIC_COLORS.primary.stroke,
  /** Pulse ring for active step */
  pulse: SEMANTIC_COLORS.start.stroke,
  /** Selection/focus ring */
  focus: SEMANTIC_COLORS.info.stroke,
} as const;

// ── Platform Colors ─────────────────────────────────────────────────────────
// Used by PlatformRateChart, social media visuals

export const PLATFORM_COLORS: Record<string, string> = {
  spotify: "#1DB954",
  apple_music: "#FC3C44",
  youtube_music: "#FF0000",
  amazon_music: "#00A8E1",
  tidal: "#000000",
  deezer: "#A238FF",
  pandora: "#005483",
  soundcloud: "#FF5500",
};
