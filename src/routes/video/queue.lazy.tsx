import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { CheckCircle2, CircleStop, ListVideo, Loader2, X, XCircle } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import {
  renderJobsQueryOptions,
  useDeleteRenderJob,
  type RenderJob,
  type RenderJobStatus,
} from "@/lib/queries/video/render-jobs";
import { renderCancel } from "@/lib/tauri-cmd";

export const Route = createLazyFileRoute("/video/queue")({
  component: RenderQueuePage,
});

function RenderQueuePage() {
  const { data, isLoading, error } = useQuery(renderJobsQueryOptions());
  const del = useDeleteRenderJob();

  const jobs = data ?? [];
  const counts = useMemo(() => bucket(jobs), [jobs]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <ListVideo className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Render queue</h1>
          <span className="text-sm text-muted-foreground">
            ({jobs.length})
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {counts.running} running · {counts.complete} complete · {counts.failed} failed · {counts.cancelled} cancelled.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading queue…
          </div>
        )}
        {error instanceof Error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error.message}
          </div>
        )}
        {!isLoading && jobs.length === 0 && (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No renders yet. Trigger one from a composition.
          </div>
        )}
        {jobs.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Composition</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Progress</th>
                  <th className="px-3 py-2 text-left font-medium">Output</th>
                  <th className="px-3 py-2 text-left font-medium">Created</th>
                  <th className="w-32 px-3 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <RenderRow
                    key={job.id}
                    job={job}
                    onDelete={() => del.mutate(job.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RenderRow({
  job,
  onDelete,
}: {
  job: RenderJob;
  onDelete: () => void;
}) {
  const pct = Math.round(job.progress * 100);
  const isTerminal =
    job.status === "complete" ||
    job.status === "failed" ||
    job.status === "cancelled";

  function handleOpen() {
    if (job.status !== "complete") return;
    void openExternal(job.output_path).catch((e) => console.error("open:", e));
  }

  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 font-mono text-xs">{job.composition_id}</td>
      <td className="px-3 py-2">
        <StatusBadge status={job.status} />
      </td>
      <td className="px-3 py-2">
        {job.status === "running" ? (
          <div className="flex items-center gap-2">
            <div className="relative h-1.5 w-32 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="absolute inset-y-0 left-0 bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {pct}%
            </span>
          </div>
        ) : (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {pct}%
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {job.status === "complete" ? (
          <button
            type="button"
            onClick={handleOpen}
            className="max-w-[20rem] truncate text-left text-foreground hover:underline"
            title={job.output_path}
          >
            {shortPath(job.output_path)}
          </button>
        ) : (
          <span className="max-w-[20rem] truncate text-muted-foreground" title={job.output_path}>
            {shortPath(job.output_path)}
          </span>
        )}
        {job.error && (
          <div className="max-w-[24rem] truncate text-[10px] text-destructive" title={job.error}>
            {job.error}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatRelative(job.created_at)}
      </td>
      <td className="px-3 py-2 text-right">
        {job.status === "running" || job.status === "queued" ? (
          <button
            type="button"
            onClick={() => void renderCancel(job.id)}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-destructive/10 hover:text-destructive"
          >
            <CircleStop className="h-3 w-3" />
            Cancel
          </button>
        ) : isTerminal ? (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
          >
            <X className="h-3 w-3" />
            Dismiss
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: RenderJobStatus }) {
  const cfg: Record<RenderJobStatus, { label: string; klass: string; Icon: typeof Loader2 }> = {
    queued: {
      label: "queued",
      klass: "border-muted bg-muted text-muted-foreground",
      Icon: Loader2,
    },
    running: {
      label: "running",
      klass: "border-primary/50 bg-primary/10 text-primary",
      Icon: Loader2,
    },
    complete: {
      label: "complete",
      klass: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      Icon: CheckCircle2,
    },
    failed: {
      label: "failed",
      klass: "border-destructive/50 bg-destructive/10 text-destructive",
      Icon: XCircle,
    },
    cancelled: {
      label: "cancelled",
      klass: "border-muted bg-muted text-muted-foreground",
      Icon: X,
    },
  };
  const { label, klass, Icon } = cfg[status];
  const spinning = status === "queued" || status === "running";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${klass}`}
    >
      <Icon className={`h-3 w-3 ${spinning ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}

function bucket(jobs: RenderJob[]) {
  const out = { running: 0, complete: 0, failed: 0, cancelled: 0, queued: 0 };
  for (const j of jobs) out[j.status]++;
  return out;
}

function shortPath(p: string): string {
  const home = "/home/nedjamez";
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatRelative(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
