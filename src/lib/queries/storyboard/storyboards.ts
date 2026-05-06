/**
 * Storyboard CRUD via direct dbExec/dbQuery (matches phase 6 render-jobs
 * pattern). Heavy reads use a join to assemble beat rows; mutations operate
 * row-by-row on `storyboards` and `storyboard_beats`.
 */

import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { dbExec, dbQuery } from "@/lib/tauri-cmd";
import {
  rowToStoryboard,
  type Storyboard,
  type StoryboardBeat,
  type StoryboardBeatRow,
  type StoryboardRow,
  type StoryboardSummary,
} from "@/lib/storyboard/types";

const STORYBOARDS_KEY = ["storyboards"] as const;
const STORYBOARD_KEY = (id: string) => ["storyboards", id] as const;

export const storyboardsQueryKey = STORYBOARDS_KEY;
export const storyboardQueryKey = STORYBOARD_KEY;

// ─── List summaries (homepage) ────────────────────────────────────────────────

export function storyboardSummariesQueryOptions() {
  return queryOptions({
    queryKey: STORYBOARDS_KEY,
    queryFn: async (): Promise<StoryboardSummary[]> => {
      const rows = await dbQuery<{
        id: string;
        title: string;
        current_rung: number;
        composition_id: string | null;
        beats_total: number;
        beats_approved: number;
        updated_at: number;
      }>(
        `SELECT
           s.id,
           s.title,
           s.current_rung,
           s.composition_id,
           s.updated_at,
           (SELECT COUNT(*) FROM storyboard_beats b WHERE b.storyboard_id = s.id) AS beats_total,
           (SELECT COUNT(*)
              FROM storyboard_beats b
              WHERE b.storyboard_id = s.id
                AND CASE s.current_rung
                      WHEN 0 THEN b.r0_status
                      WHEN 1 THEN b.r1_status
                      WHEN 2 THEN b.r2_status
                    END = 'approved'
           ) AS beats_approved
         FROM storyboards s
         ORDER BY s.updated_at DESC
         LIMIT 200`,
      );
      return rows;
    },
  });
}

// ─── Get one (full) ───────────────────────────────────────────────────────────

export interface StoryboardWithMeta {
  storyboard: Storyboard;
  compositionId: string | null;
  blogPostId: string | null;
  sourceKind: string | null;
  sourceRef: string | null;
  version: number;
  updatedAt: number;
}

export function storyboardQueryOptions(id: string) {
  return queryOptions({
    queryKey: STORYBOARD_KEY(id),
    queryFn: async (): Promise<StoryboardWithMeta | null> => {
      const head = await dbQuery<StoryboardRow>(
        `SELECT id, title, blog_post_id, source_kind, source_ref, current_rung,
                composition_id, narration, selected_concepts, selected_concepts_note,
                exported_at, version, created_at, updated_at
         FROM storyboards WHERE id = ?`,
        [id],
      );
      if (head.length === 0) return null;
      const beats = await dbQuery<StoryboardBeatRow>(
        `SELECT id, storyboard_id, index_in_board, label, time_start, time_end,
                frame_start, frame_end, narration_excerpt, intent,
                r0_status, r0_content, r1_status, r1_still_path, r1_tsx_anchor,
                r2_status, r2_still_path, comments
         FROM storyboard_beats WHERE storyboard_id = ? ORDER BY index_in_board`,
        [id],
      );
      const row = head[0];
      return {
        storyboard: rowToStoryboard(row, beats),
        compositionId: row.composition_id,
        blogPostId: row.blog_post_id,
        sourceKind: row.source_kind,
        sourceRef: row.source_ref,
        version: row.version,
        updatedAt: row.updated_at,
      };
    },
    enabled: !!id,
  });
}

// ─── Create / update ──────────────────────────────────────────────────────────

export interface CreateStoryboardInput {
  id: string;
  title: string;
  blogPostId?: string | null;
  sourceKind?: "blog" | "markdown" | "blank" | "imported";
  sourceRef?: string | null;
  compositionId?: string | null;
}

export async function createStoryboard(input: CreateStoryboardInput): Promise<void> {
  const now = Date.now();
  await dbExec(
    `INSERT INTO storyboards
       (id, title, blog_post_id, source_kind, source_ref, current_rung,
        composition_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    [
      input.id,
      input.title,
      input.blogPostId ?? null,
      input.sourceKind ?? "blank",
      input.sourceRef ?? null,
      input.compositionId ?? null,
      now,
      now,
    ],
  );
}

export async function deleteStoryboard(id: string): Promise<void> {
  await dbExec(`DELETE FROM storyboards WHERE id = ?`, [id]);
  // CASCADE on storyboard_beats handles beat cleanup; storyboard_jobs are
  // intentionally not FK'd (they survive deletes for audit).
}

export async function updateStoryboardMeta(args: {
  id: string;
  title?: string;
  currentRung?: number;
  compositionId?: string | null;
  selectedConceptsNote?: string | null;
}): Promise<void> {
  // Build a dynamic SET clause from non-undefined fields.
  const sets: string[] = ["updated_at = ?", "version = version + 1"];
  const params: (string | number | null)[] = [Date.now()];
  if (args.title !== undefined) {
    sets.unshift("title = ?");
    params.unshift(args.title);
  }
  if (args.currentRung !== undefined) {
    sets.unshift("current_rung = ?");
    params.unshift(args.currentRung);
  }
  if (args.compositionId !== undefined) {
    sets.unshift("composition_id = ?");
    params.unshift(args.compositionId);
  }
  if (args.selectedConceptsNote !== undefined) {
    sets.unshift("selected_concepts_note = ?");
    params.unshift(args.selectedConceptsNote);
  }
  params.push(args.id);
  await dbExec(
    `UPDATE storyboards SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
}

// ─── Beat operations ─────────────────────────────────────────────────────────

export async function upsertBeat(args: {
  storyboardId: string;
  beat: StoryboardBeat;
  indexInBoard: number;
}): Promise<void> {
  const { storyboardId, beat, indexInBoard } = args;
  await dbExec(
    `INSERT INTO storyboard_beats
       (id, storyboard_id, index_in_board, label, time_start, time_end,
        frame_start, frame_end, narration_excerpt, intent,
        r0_status, r0_content, r1_status, r1_still_path, r1_tsx_anchor,
        r2_status, r2_still_path, comments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(storyboard_id, id) DO UPDATE SET
       index_in_board   = excluded.index_in_board,
       label            = excluded.label,
       time_start       = excluded.time_start,
       time_end         = excluded.time_end,
       frame_start      = excluded.frame_start,
       frame_end        = excluded.frame_end,
       narration_excerpt = excluded.narration_excerpt,
       intent           = excluded.intent,
       r0_status        = excluded.r0_status,
       r0_content       = excluded.r0_content,
       r1_status        = excluded.r1_status,
       r1_still_path    = excluded.r1_still_path,
       r1_tsx_anchor    = excluded.r1_tsx_anchor,
       r2_status        = excluded.r2_status,
       r2_still_path    = excluded.r2_still_path,
       comments         = excluded.comments`,
    [
      beat.id,
      storyboardId,
      indexInBoard,
      beat.label,
      beat.time.start,
      beat.time.end,
      beat.frames.start,
      beat.frames.end,
      beat.narration_excerpt ?? null,
      beat.intent ?? null,
      beat.rungs["0_beat_sheet"].status,
      beat.rungs["0_beat_sheet"].content ?? null,
      beat.rungs["1_lofi"].status,
      beat.rungs["1_lofi"].still_path ?? null,
      beat.rungs["1_lofi"].tsx_anchor ?? null,
      beat.rungs["2_hifi"].status,
      beat.rungs["2_hifi"].still_path ?? null,
      JSON.stringify(beat.comments ?? []),
    ],
  );
}

export async function setBeatStatus(args: {
  storyboardId: string;
  beatId: string;
  rung: 0 | 1 | 2;
  status: "pending" | "pending-review" | "approved" | "needs-rework";
}): Promise<void> {
  const col = ["r0_status", "r1_status", "r2_status"][args.rung];
  await dbExec(
    `UPDATE storyboard_beats SET ${col} = ? WHERE storyboard_id = ? AND id = ?`,
    [args.status, args.storyboardId, args.beatId],
  );
  await touchStoryboard(args.storyboardId);
}

export async function setBeatStillPath(args: {
  storyboardId: string;
  beatId: string;
  rung: 1 | 2;
  stillPath: string | null;
  status?: "pending-review" | "approved";
}): Promise<void> {
  const pathCol = args.rung === 1 ? "r1_still_path" : "r2_still_path";
  const statusCol = args.rung === 1 ? "r1_status" : "r2_status";
  if (args.status) {
    await dbExec(
      `UPDATE storyboard_beats
         SET ${pathCol} = ?, ${statusCol} = ?
       WHERE storyboard_id = ? AND id = ?`,
      [args.stillPath, args.status, args.storyboardId, args.beatId],
    );
  } else {
    await dbExec(
      `UPDATE storyboard_beats SET ${pathCol} = ?
       WHERE storyboard_id = ? AND id = ?`,
      [args.stillPath, args.storyboardId, args.beatId],
    );
  }
  await touchStoryboard(args.storyboardId);
}

export async function appendBeatComment(args: {
  storyboardId: string;
  beatId: string;
  text: string;
  rung: number;
}): Promise<void> {
  // Read-modify-write the JSON array. Concurrent writers don't exist in v1
  // (single user), so no CAS loop needed.
  const rows = await dbQuery<{ comments: string }>(
    `SELECT comments FROM storyboard_beats WHERE storyboard_id = ? AND id = ?`,
    [args.storyboardId, args.beatId],
  );
  if (rows.length === 0) return;
  const existing = (() => {
    try {
      const v = JSON.parse(rows[0].comments);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();
  existing.push({ ts: Date.now(), rung: args.rung, text: args.text });
  await dbExec(
    `UPDATE storyboard_beats SET comments = ? WHERE storyboard_id = ? AND id = ?`,
    [JSON.stringify(existing), args.storyboardId, args.beatId],
  );
  await touchStoryboard(args.storyboardId);
}

export async function updateBeatMeta(args: {
  storyboardId: string;
  beatId: string;
  patch: {
    label?: string;
    narrationExcerpt?: string | null;
    timeStart?: number;
    timeEnd?: number;
  };
}): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const { patch } = args;
  if (patch.label !== undefined) {
    sets.push("label = ?");
    params.push(patch.label);
  }
  if (patch.narrationExcerpt !== undefined) {
    sets.push("narration_excerpt = ?");
    params.push(patch.narrationExcerpt);
  }
  if (patch.timeStart !== undefined) {
    sets.push("time_start = ?");
    params.push(patch.timeStart);
  }
  if (patch.timeEnd !== undefined) {
    sets.push("time_end = ?");
    params.push(patch.timeEnd);
  }
  if (sets.length === 0) return;
  params.push(args.storyboardId, args.beatId);
  await dbExec(
    `UPDATE storyboard_beats SET ${sets.join(", ")}
     WHERE storyboard_id = ? AND id = ?`,
    params,
  );
  await touchStoryboard(args.storyboardId);
}

async function touchStoryboard(id: string) {
  await dbExec(
    `UPDATE storyboards SET updated_at = ?, version = version + 1 WHERE id = ?`,
    [Date.now(), id],
  );
}

// ─── React Query mutation hooks ───────────────────────────────────────────────

export function useDeleteStoryboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteStoryboard,
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: STORYBOARDS_KEY });
      qc.invalidateQueries({ queryKey: STORYBOARD_KEY(id) });
    },
  });
}
