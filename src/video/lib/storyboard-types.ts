/**
 * Storyboard Types — shared enums consumed by the freeform pipeline (Phase 3)
 * and the storyboard app (Phase 2D). Single source of truth.
 *
 * Do not add composition-specific types here; keep this file small and
 * dependency-free (no Zod, no React, no Remotion).
 */

// ── Beat approval lifecycle ────────────────────────────────────────────────

/**
 * BeatStatus — lifecycle state for a single beat at a given rung.
 *
 *   pending         → not yet started / scaffolded
 *   pending-review  → generated, awaiting human sign-off
 *   approved        → human approved; pipeline may proceed to next rung
 *   needs-rework    → human left feedback; agent must revise before re-queuing
 */
export type BeatStatus =
  | "pending"
  | "pending-review"
  | "approved"
  | "needs-rework";

// ── Storyboard rungs ───────────────────────────────────────────────────────

/**
 * Rung — the three progressive fidelity levels of the storyboard workflow.
 *
 *   0_beat_sheet   → text description + timing only (Rung 0)
 *   1_lofi         → wireframe still, lo-fi BrandProvider palette (Rung 1)
 *   2_hifi         → production render, full palette + effects (Rung 2)
 *
 * The numeric prefix keeps rung keys sortable as strings.
 */
export type Rung = "0_beat_sheet" | "1_lofi" | "2_hifi";

/** Numeric mapping for convenience (rung index ↔ string key). */
export const RUNG_LABELS: Record<number, Rung> = {
  0: "0_beat_sheet",
  1: "1_lofi",
  2: "2_hifi",
};

export const RUNG_NUMBERS: Record<Rung, number> = {
  "0_beat_sheet": 0,
  "1_lofi": 1,
  "2_hifi": 2,
};
