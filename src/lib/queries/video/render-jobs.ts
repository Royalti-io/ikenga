import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { dbExec, dbQuery } from "@/lib/tauri-cmd";

export type RenderJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export interface RenderJob {
  id: string;
  composition_id: string;
  props: string;       // JSON string
  output_path: string;
  status: RenderJobStatus;
  progress: number;    // 0..1
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  created_at: number;
}

const RENDER_JOBS_QUERY_KEY = ["render-jobs"] as const;

export const renderJobsQueryKey = RENDER_JOBS_QUERY_KEY;

export function renderJobsQueryOptions() {
  return queryOptions({
    queryKey: RENDER_JOBS_QUERY_KEY,
    queryFn: () =>
      dbQuery<RenderJob>(
        `SELECT id, composition_id, props, output_path, status, progress,
                started_at, completed_at, error, created_at
         FROM render_jobs
         ORDER BY created_at DESC
         LIMIT 200`,
      ),
    // Polling keeps the queue live while a render is in flight. 1.5s is the
    // sweet spot — fast enough to feel responsive, slow enough not to thrash
    // sqlite during a long render.
    refetchInterval: 1500,
  });
}

export async function insertRenderJob(job: {
  id: string;
  compositionId: string;
  props: unknown;
  outputPath: string;
}) {
  const now = Date.now();
  await dbExec(
    `INSERT INTO render_jobs
       (id, composition_id, props, output_path, status, progress, created_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
    [job.id, job.compositionId, JSON.stringify(job.props), job.outputPath, now],
  );
}

export async function markRunning(id: string) {
  await dbExec(
    `UPDATE render_jobs SET status = 'running', started_at = ? WHERE id = ?`,
    [Date.now(), id],
  );
}

export async function setProgress(id: string, value: number) {
  await dbExec(`UPDATE render_jobs SET progress = ? WHERE id = ?`, [value, id]);
}

export async function markComplete(id: string, outputPath: string) {
  await dbExec(
    `UPDATE render_jobs
       SET status = 'complete', progress = 1, completed_at = ?, output_path = ?
     WHERE id = ?`,
    [Date.now(), outputPath, id],
  );
}

export async function markFailed(id: string, message: string) {
  await dbExec(
    `UPDATE render_jobs
       SET status = 'failed', completed_at = ?, error = ?
     WHERE id = ?`,
    [Date.now(), message, id],
  );
}

export async function markCancelled(id: string) {
  await dbExec(
    `UPDATE render_jobs SET status = 'cancelled', completed_at = ? WHERE id = ?`,
    [Date.now(), id],
  );
}

export async function deleteRenderJob(id: string) {
  await dbExec(`DELETE FROM render_jobs WHERE id = ?`, [id]);
}

export function useDeleteRenderJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRenderJob,
    onSuccess: () => qc.invalidateQueries({ queryKey: RENDER_JOBS_QUERY_KEY }),
  });
}
