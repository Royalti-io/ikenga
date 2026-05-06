/**
 * Centralized font loading for the Royalti Video Engine.
 *
 * ALL loadFont() calls happen here. Components only import the
 * fontFamily strings — never call loadFont() themselves.
 *
 * Fonts: Plus Jakarta Sans (primary), JetBrains Mono (code).
 * Source: Pencil design system (--font-primary).
 */

import { loadFont as loadJakarta } from "@remotion/google-fonts/PlusJakartaSans";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const jakarta = loadJakarta();
const mono = loadMono();

/** Primary font family — headings, body text, UI elements. */
export const fontFamily = jakarta.fontFamily;

/** Monospace font family — code blocks, terminal text. */
export const monoFontFamily = mono.fontFamily;

/** Font info objects (for advanced use like waitForFont). */
export const fonts = {
  primary: jakarta,
  mono,
} as const;
