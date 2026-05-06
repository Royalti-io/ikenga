/**
 * Storyboard FE types — bridge between SQLite row shape and the canonical
 * Zod schema from phase 6 (@/video/lib/storyboard-schema).
 *
 * The SQLite schema flattens rungs to columns for query speed; this module
 * provides a pair of helpers (rowToStoryboard / storyboardToRow) so the rest
 * of the app can work with the canonical `Storyboard` type.
 */

import {
  StoryboardSchema,
  type Storyboard,
  type StoryboardBeat,
  type BeatComment,
} from "@/video/lib/storyboard-schema";

export type {
  Storyboard,
  StoryboardBeat,
  BeatComment,
} from "@/video/lib/storyboard-schema";
export type { BeatStatus, Rung } from "@/video/lib/storyboard-types";

// ─── SQLite row shapes ────────────────────────────────────────────────────────

export interface StoryboardRow {
  id: string;
  title: string;
  blog_post_id: string | null;
  source_kind: string | null;
  source_ref: string | null;
  current_rung: number;
  composition_id: string | null;
  narration: string | null; // JSON or NULL
  selected_concepts: string | null; // JSON array or NULL
  selected_concepts_note: string | null;
  exported_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface StoryboardBeatRow {
  id: string;
  storyboard_id: string;
  index_in_board: number;
  label: string;
  time_start: number;
  time_end: number;
  frame_start: number;
  frame_end: number;
  narration_excerpt: string | null;
  intent: string | null;
  r0_status: string;
  r0_content: string | null;
  r1_status: string;
  r1_still_path: string | null;
  r1_tsx_anchor: string | null;
  r2_status: string;
  r2_still_path: string | null;
  comments: string; // JSON array
}

export interface StoryboardSummary {
  id: string;
  title: string;
  current_rung: number;
  composition_id: string | null;
  beats_total: number;
  beats_approved: number;
  updated_at: number;
}

// ─── Row ↔ canonical Storyboard ───────────────────────────────────────────────

export function rowToStoryboard(
  row: StoryboardRow,
  beatRows: StoryboardBeatRow[],
): Storyboard {
  const beats: StoryboardBeat[] = beatRows
    .slice()
    .sort((a, b) => a.index_in_board - b.index_in_board)
    .map((b) => ({
      id: b.id,
      label: b.label,
      time: { start: b.time_start, end: b.time_end },
      frames: { start: b.frame_start, end: b.frame_end },
      narration_excerpt: b.narration_excerpt ?? undefined,
      intent: b.intent ?? undefined,
      rungs: {
        "0_beat_sheet": {
          status: b.r0_status as StoryboardBeat["rungs"]["0_beat_sheet"]["status"],
          content: b.r0_content ?? undefined,
        },
        "1_lofi": {
          status: b.r1_status as StoryboardBeat["rungs"]["1_lofi"]["status"],
          still_path: b.r1_still_path ?? undefined,
          tsx_anchor: b.r1_tsx_anchor ?? undefined,
        },
        "2_hifi": {
          status: b.r2_status as StoryboardBeat["rungs"]["2_hifi"]["status"],
          still_path: b.r2_still_path ?? undefined,
        },
      },
      comments: parseComments(b.comments),
    }));

  const sb: Storyboard = {
    slug: row.id,
    title: row.title,
    current_rung: row.current_rung,
    narration: row.narration ? JSON.parse(row.narration) : undefined,
    selected_concepts: row.selected_concepts
      ? JSON.parse(row.selected_concepts)
      : undefined,
    selected_concepts_note: row.selected_concepts_note ?? undefined,
    beats,
  };

  // Validate before handing to consumers — catches schema drift fast.
  return StoryboardSchema.parse(sb);
}

function parseComments(raw: string): BeatComment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
