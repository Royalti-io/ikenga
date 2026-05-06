/**
 * storyboard_jobs CRUD — mirrors lib/queries/video/render-jobs.ts.
 * Long-running storyboard ops (render-still, promote-rung, regenerate-beat)
 * persist their state here so the UI survives reloads / nav-aways.
 */

import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { dbExec, dbQuery } from "@/lib/tauri-cmd";

export type StoryboardJobKind =
  | "render_still"
  | "promote_rung"
  | "regenerate_beat";

export type StoryboardJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export interface StoryboardJob {
  id: string;
  storyboard_id: string;
  kind: StoryboardJobKind;
  beat_id: string | null;
  target_rung: number | null;
  status: StoryboardJobStatus;
  progress: number;
  log: string;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

const JOBS_KEY = ["storyboard-jobs"] as const;
const JOBS_FOR_STORYBOARD = (id: string) =>
  ["storyboard-jobs", id] as const;

export const storyboardJobsQueryKey = JOBS_KEY;

export function storyboardJobsQueryOptions(storyboardId?: string) {
  return queryOptions({
    queryKey: storyboardId ? JOBS_FOR_STORYBOARD(storyboardId) : JOBS_KEY,
    queryFn: async () => {
      if (storyboardId) {
        return dbQuery<StoryboardJob>(
          `SELECT id, storyboard_id, kind, beat_id, target_rung, status, progress,
                  log, error, started_at, completed_at, created_at
           FROM storyboard_jobs WHERE storyboard_id = ?
           ORDER BY created_at DESC LIMIT 100`,
          [storyboardId],
        );
      }
      return dbQuery<StoryboardJob>(
        `SELECT id, storyboard_id, kind, beat_id, target_rung, status, progress,
                log, error, started_at, completed_at, created_at
         FROM storyboard_jobs ORDER BY created_at DESC LIMIT 200`,
      );
    },
    refetchInterval: 1500,
  });
}

export async function insertStoryboardJob(args: {
  id: string;
  storyboardId: string;
  kind: StoryboardJobKind;
  beatId?: string | null;
  targetRung?: number | null;
}): Promise<void> {
  await dbExec(
    `INSERT INTO storyboard_jobs
       (id, storyboard_id, kind, beat_id, target_rung, status, progress, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)`,
    [
      args.id,
      args.storyboardId,
      args.kind,
      args.beatId ?? null,
      args.targetRung ?? null,
      Date.now(),
    ],
  );
}

export async function markJobRunning(id: string) {
  await dbExec(
    `UPDATE storyboard_jobs SET status = 'running', started_at = ? WHERE id = ?`,
    [Date.now(), id],
  );
}

export async function setJobProgress(id: string, value: number) {
  await dbExec(`UPDATE storyboard_jobs SET progress = ? WHERE id = ?`, [
    value,
    id,
  ]);
}

export async function appendJobLog(id: string, line: string) {
  // 4KB tail cap to avoid SQLite blob bloat on chatty CLIs.
  const rows = await dbQuery<{ log: string }>(
    `SELECT log FROM storyboard_jobs WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) return;
  const next = `${rows[0].log}${line}\n`;
  const tail = next.length > 4096 ? next.slice(next.length - 4096) : next;
  await dbExec(`UPDATE storyboard_jobs SET log = ? WHERE id = ?`, [tail, id]);
}

export async function markJobComplete(id: string) {
  await dbExec(
    `UPDATE storyboard_jobs
       SET status = 'complete', progress = 1, completed_at = ?
     WHERE id = ?`,
    [Date.now(), id],
  );
}

export async function markJobFailed(id: string, message: string) {
  await dbExec(
    `UPDATE storyboard_jobs
       SET status = 'failed', completed_at = ?, error = ?
     WHERE id = ?`,
    [Date.now(), message, id],
  );
}

export async function deleteStoryboardJob(id: string) {
  await dbExec(`DELETE FROM storyboard_jobs WHERE id = ?`, [id]);
}

export function useDeleteStoryboardJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteStoryboardJob,
    onSuccess: () => qc.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}
