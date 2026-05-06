/**
 * Left-rail beat list with status filters. Ported from BeatStrip.tsx but
 * using PA design tokens.
 */

import { useMemo } from "react";

import { cn } from "@/components/ui/utils";
import type {
  BeatStatus,
  Storyboard,
  StoryboardBeat,
} from "@/lib/storyboard/types";

interface BeatStripProps {
  storyboard: Storyboard;
  activeBeatIndex: number;
  activeRung: 0 | 1 | 2;
  filters: Record<BeatStatus, boolean>;
  onSelectBeat: (index: number) => void;
  onToggleFilter: (status: BeatStatus) => void;
}

const STATUS_DOT: Record<BeatStatus, string> = {
  pending: "bg-muted-foreground",
  "pending-review": "bg-amber-500",
  approved: "bg-emerald-500",
  "needs-rework": "bg-red-500",
};

const STATUS_LABEL: Record<BeatStatus, string> = {
  pending: "pending",
  "pending-review": "review",
  approved: "approved",
  "needs-rework": "rework",
};

const RUNG_KEY = ["0_beat_sheet", "1_lofi", "2_hifi"] as const;

function statusForBeat(beat: StoryboardBeat, rung: 0 | 1 | 2): BeatStatus {
  return beat.rungs[RUNG_KEY[rung]].status;
}

export function BeatStrip({
  storyboard,
  activeBeatIndex,
  activeRung,
  filters,
  onSelectBeat,
  onToggleFilter,
}: BeatStripProps) {
  const visibleIndexes = useMemo(() => {
    const out: number[] = [];
    storyboard.beats.forEach((b, i) => {
      const st = statusForBeat(b, activeRung);
      if (filters[st]) out.push(i);
    });
    return out;
  }, [storyboard.beats, activeRung, filters]);

  const total = storyboard.beats.length;
  const hidden = total - visibleIndexes.length;

  return (
    <aside className="flex w-[260px] flex-shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Beats · {total}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          showing rung {activeRung} status
          {hidden > 0 && (
            <span className="text-amber-600"> · {hidden} hidden</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {visibleIndexes.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No beats match the current filters.
          </div>
        ) : (
          <ul>
            {visibleIndexes.map((i) => {
              const beat = storyboard.beats[i];
              const status = statusForBeat(beat, activeRung);
              const isActive = i === activeBeatIndex;
              return (
                <li key={beat.id}>
                  <button
                    type="button"
                    onClick={() => onSelectBeat(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left text-sm transition-colors",
                      isActive
                        ? "border-primary bg-accent"
                        : "border-transparent hover:bg-accent/50",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-2 w-2 flex-shrink-0 rounded-full",
                        STATUS_DOT[status],
                      )}
                    />
                    <span className="flex-shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={cn(
                        "flex-1 truncate",
                        isActive ? "font-semibold" : "text-muted-foreground",
                      )}
                    >
                      {beat.label}
                    </span>
                    {beat.comments.length > 0 && (
                      <span
                        className="flex-shrink-0 font-mono text-[10px] text-muted-foreground"
                        title={`${beat.comments.length} comment(s)`}
                      >
                        ◆{beat.comments.length}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border">
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Filter
          </div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(filters) as BeatStatus[]).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => onToggleFilter(st)}
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                  filters[st]
                    ? "border-border bg-muted text-foreground"
                    : "border-border bg-card text-muted-foreground opacity-50",
                )}
              >
                <span
                  className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_DOT[st])}
                />
                {STATUS_LABEL[st]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-0.5 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
          <div>
            <kbd className="font-mono">↑/↓</kbd> rung &nbsp;
            <kbd className="font-mono">←/→</kbd> beat
          </div>
          <div>
            <kbd className="font-mono">A</kbd> approve &nbsp;
            <kbd className="font-mono">R</kbd> rework
          </div>
          <div>
            <kbd className="font-mono">C</kbd> comment &nbsp;
            <kbd className="font-mono">N</kbd> send note
          </div>
          <div>
            <kbd className="font-mono">E</kbd> tweak
          </div>
        </div>
      </div>
    </aside>
  );
}
