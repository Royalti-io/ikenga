/**
 * Top header for the storyboard editor: title, current rung indicator,
 * bulk-approve, and back-to-list link. Ported from RungBar.tsx using PA
 * tokens. Concepts tab is descoped (phase 7.1).
 */

import { ChevronLeft, CircleStop, Film, Loader2, RefreshCw } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { getRegistry } from "@/video/registry";
import { defaultOutputPath, useRender } from "@/video/use-render";
import type { BeatStatus, Storyboard } from "@/lib/storyboard/types";

interface RungBarProps {
  storyboard: Storyboard;
  compositionId: string | null;
  onRefresh: () => void;
  onBulkApprove: () => void;
}

const RUNG_LABEL = ["Beat Sheet", "Lo-fi", "Hi-fi"] as const;
const RUNG_KEYS = ["0_beat_sheet", "1_lofi", "2_hifi"] as const;

function countsAt(storyboard: Storyboard, rung: 0 | 1 | 2) {
  const key = RUNG_KEYS[rung];
  let approved = 0;
  let review = 0;
  let rework = 0;
  for (const beat of storyboard.beats) {
    const st: BeatStatus = beat.rungs[key].status;
    if (st === "approved") approved++;
    else if (st === "pending-review") review++;
    else if (st === "needs-rework") rework++;
  }
  return { approved, review, rework, total: storyboard.beats.length };
}

export function RungBar({
  storyboard,
  compositionId,
  onRefresh,
  onBulkApprove,
}: RungBarProps) {
  const cur = storyboard.current_rung as 0 | 1 | 2;
  const counts = countsAt(storyboard, cur);
  const allApproved = counts.approved === counts.total && counts.total > 0;
  const composition = compositionId
    ? getRegistry().find((c) => c.id === compositionId)
    : null;
  const render = useRender();
  const renderRunning =
    render.state.status === "starting" || render.state.status === "running";

  const handleRenderVideo = () => {
    if (!composition) return;
    render.start(
      composition.id,
      { ...composition.defaultProps },
      defaultOutputPath(composition.id),
    );
  };

  const handleBulkApprove = () => {
    if (allApproved || counts.total === 0) return;
    const ok = window.confirm(
      `Approve all ${counts.total} beats at Rung ${cur} (${RUNG_LABEL[cur]})?\n\nIndividual beats can still be changed afterwards.`,
    );
    if (ok) onBulkApprove();
  };

  return (
    <div className="sticky top-0 z-10 border-b border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Link
          to="/storyboard"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          <ChevronLeft className="h-3 w-3" />
          Storyboards
        </Link>
        <div className="h-4 w-px bg-border" />
        <h1 className="truncate text-sm font-semibold">{storyboard.title}</h1>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {storyboard.slug}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {composition &&
            (renderRunning ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => render.cancel()}
              >
                <CircleStop className="mr-1 h-4 w-4" />
                Cancel render
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleRenderVideo}
                title={`Render ${composition.id} via Remotion`}
              >
                {render.state.status === "starting" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Film className="mr-1 h-4 w-4" />
                )}
                Render video
              </Button>
            ))}
          <Button size="sm" variant="ghost" onClick={onRefresh} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {render.state.status !== "idle" && (
        <RenderStatus state={render.state} onReset={render.reset} />
      )}

      <div className="flex items-center gap-4 border-t border-border bg-muted/30 px-4 py-2">
        <div className="flex items-center gap-1.5">
          {([0, 1, 2] as const).map((r) => {
            const c = countsAt(storyboard, r);
            const isCurrent = r === cur;
            const isDone = c.approved === c.total && c.total > 0;
            return (
              <div
                key={r}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                  isCurrent
                    ? "border-primary bg-primary text-primary-foreground"
                    : isDone
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                      : "border-border bg-background text-muted-foreground",
                )}
                title={`Rung ${r}: ${c.approved}/${c.total} approved`}
              >
                <span className="font-mono">{r}</span>
                <span>{RUNG_LABEL[r]}</span>
              </div>
            );
          })}
        </div>

        <div className="h-4 w-px bg-border" />

        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">
            Rung {cur} · {RUNG_LABEL[cur]}
          </span>
          <span className="mx-2">·</span>
          <span>
            {counts.approved}/{counts.total} approved
          </span>
          {counts.review > 0 && (
            <>
              <span className="mx-2">·</span>
              <span className="text-amber-600 dark:text-amber-400">
                {counts.review} review
              </span>
            </>
          )}
          {counts.rework > 0 && (
            <>
              <span className="mx-2">·</span>
              <span className="text-red-600 dark:text-red-400">
                {counts.rework} rework
              </span>
            </>
          )}
        </div>

        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            onClick={handleBulkApprove}
            disabled={allApproved || counts.total === 0}
          >
            {allApproved
              ? `All ${RUNG_LABEL[cur]} approved ✓`
              : `Bulk approve Rung ${cur}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RenderStatus({
  state,
  onReset,
}: {
  state: ReturnType<typeof useRender>["state"];
  onReset: () => void;
}) {
  const pct = state.progress == null ? null : Math.round(state.progress * 100);
  const tone =
    state.status === "complete"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
      : state.status === "error"
        ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
        : "bg-muted/50 text-muted-foreground";
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border px-4 py-1.5 text-xs",
        tone,
      )}
    >
      <span className="font-mono uppercase tracking-wide">{state.status}</span>
      {pct !== null && (
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="absolute inset-y-0 left-0 bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {pct !== null && (
        <span className="font-mono tabular-nums">{pct}%</span>
      )}
      {state.outputPath && (
        <span
          className="truncate font-mono text-muted-foreground"
          title={state.outputPath}
        >
          → {state.outputPath}
        </span>
      )}
      {state.error && (
        <span className="truncate font-mono" title={state.error}>
          {state.error}
        </span>
      )}
      {(state.status === "complete" ||
        state.status === "error" ||
        state.status === "cancelled") && (
        <button
          type="button"
          onClick={onReset}
          className="ml-auto rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
