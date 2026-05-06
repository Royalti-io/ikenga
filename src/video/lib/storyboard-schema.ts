/**
 * storyboard-schema.ts — Zod contract for storyboard.json.
 *
 * This is the single source of truth shared between:
 *   - Phase 3 (freeform pipeline): writes storyboard.json
 *   - Phase 2D (storyboard app): reads storyboard.json
 *   - defineBeats() output gets embedded here
 *
 * The `current_rung` field is a 0/1/2 integer (not the string Rung type)
 * because it's the active pointer the app increments, not a key. Use
 * RUNG_LABELS[current_rung] to get the string key.
 */

import { z } from "zod";

// ── Re-export for consumers that want the Zod enum too ─────────────────────

export const BeatStatusSchema = z.enum([
  "pending",
  "pending-review",
  "approved",
  "needs-rework",
]);

// ── Per-rung data ──────────────────────────────────────────────────────────

const BeatSheet0Schema = z.object({
  status: BeatStatusSchema,
  /** Free-form content note written during beat-sheet phase. */
  content: z.string().optional(),
});

const Lofi1Schema = z.object({
  status: BeatStatusSchema,
  /** Path to the lo-fi still PNG (relative to storyboard output dir). */
  still_path: z.string().optional(),
  /**
   * file:line anchor pointing to where this beat's TSX block lives.
   * Format: "src/compositions/AskRoyClipVideo.tsx:171"
   * Used by the storyboard app to open the right place in an editor.
   */
  tsx_anchor: z.string().optional(),
});

const Hifi2Schema = z.object({
  status: BeatStatusSchema,
  /** Path to the hi-fi still PNG. */
  still_path: z.string().optional(),
});

// ── Comment ────────────────────────────────────────────────────────────────

const CommentSchema = z.object({
  /** Unix timestamp in milliseconds. */
  ts: z.number(),
  /** Rung number this comment was left on (0/1/2). */
  rung: z.number(),
  /** Comment text. */
  text: z.string(),
});

// ── Beat ───────────────────────────────────────────────────────────────────

const BeatSchema = z.object({
  id: z.string(),
  label: z.string(),
  time: z.object({
    start: z.number(),
    end: z.number(),
  }),
  frames: z.object({
    start: z.number(),
    end: z.number(),
  }),
  narration_excerpt: z.string().optional(),
  intent: z.string().optional(),
  rungs: z.object({
    "0_beat_sheet": BeatSheet0Schema,
    "1_lofi": Lofi1Schema,
    "2_hifi": Hifi2Schema,
  }),
  comments: z.array(CommentSchema).default([]),
});

// ── Top-level storyboard ───────────────────────────────────────────────────

export const StoryboardSchema = z.object({
  /** Composition slug — matches the storyboard.json filename without extension. */
  slug: z.string(),
  /** Human-readable composition title. */
  title: z.string(),
  /**
   * Narration data. Optional — present only when audio has been generated.
   * `words` are composition-absolute timestamps in seconds.
   */
  narration: z
    .object({
      /** Path to the audio file (relative to public/). */
      audio: z.string(),
      words: z.array(
        z.object({
          word: z.string(),
          start: z.number(),
          end: z.number(),
        }),
      ),
    })
    .optional(),
  /**
   * Current active rung (0 = beat-sheet, 1 = lo-fi, 2 = hi-fi).
   * The pipeline advances this when all beats at the current rung are approved.
   */
  current_rung: z.number().int().min(0).max(2),
  /**
   * User-selected concept frames (pre-Rung-0 mood/direction). Each entry
   * references a file in `compositions/{slug}/concepts/` and binds Rung 1
   * generation to that visual world. Multi-select is allowed for hybrids
   * (e.g. "chat surface from concept 1, citation substance from concept 3");
   * use `role` to label what each pick contributes.
   */
  selected_concepts: z
    .array(
      z.object({
        filename: z.string(),
        role: z.string().optional(),
      }),
    )
    .optional(),
  /** Optional freeform note explaining the concept selection (esp. hybrids). */
  selected_concepts_note: z.string().optional(),
  beats: z.array(BeatSchema),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type Storyboard = z.infer<typeof StoryboardSchema>;
export type StoryboardBeat = z.infer<typeof BeatSchema>;
export type BeatComment = z.infer<typeof CommentSchema>;
