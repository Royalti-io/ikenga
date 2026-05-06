/**
 * Storyboard editor — top-level component that orchestrates the editor:
 * RungBar (header) + BeatStrip (left) + ReviewPane (center). Owns the
 * mutation logic, keyboard wiring, and render-still workflow.
 *
 * Mirrors storyboard-app/src/pages/StoryboardPage.tsx, adapted to PA's
 * SQLite-backed persistence (instead of HTTP PUT to express).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  storyboardJobsQueryOptions,
  insertStoryboardJob,
  markJobComplete,
  markJobFailed,
  markJobRunning,
} from "@/lib/queries/storyboard/jobs";
import {
  appendBeatComment,
  setBeatStatus,
  setBeatStillPath,
  storyboardQueryOptions,
  updateBeatMeta,
  updateStoryboardMeta,
  upsertBeat,
} from "@/lib/queries/storyboard/storyboards";
import {
  storyboardExportJson,
  storyboardListenJob,
  storyboardRenderStill,
} from "@/lib/tauri-cmd";
import type {
  BeatStatus,
  Rung,
  Storyboard,
  StoryboardBeat,
} from "@/lib/storyboard/types";

import { BeatStrip } from "./beat-strip";
import { ReviewPane, type ReviewPaneRef } from "./review-pane";
import { RungBar } from "./rung-bar";
import { useKeyboard } from "./use-keyboard";

const RUNG_KEY_FROM_NUM: Record<0 | 1 | 2, Rung> = {
  0: "0_beat_sheet",
  1: "1_lofi",
  2: "2_hifi",
};

const DEFAULT_FILTERS: Record<BeatStatus, boolean> = {
  pending: true,
  "pending-review": true,
  approved: true,
  "needs-rework": true,
};

const FILTER_PRESETS: Record<BeatStatus, boolean>[] = [
  { pending: true, "pending-review": true, approved: true, "needs-rework": true },
  { pending: false, "pending-review": true, approved: false, "needs-rework": true },
  { pending: true, "pending-review": false, approved: false, "needs-rework": false },
];

export function StoryboardEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const sbQuery = useQuery(storyboardQueryOptions(id));
  // Subscribe to jobs so the FE refreshes still paths as renders complete.
  useQuery(storyboardJobsQueryOptions(id));

  const storyboard = sbQuery.data?.storyboard ?? null;
  const compositionId = sbQuery.data?.compositionId ?? null;

  const [activeBeatIndex, setActiveBeatIndex] = useState(0);
  const [activeRung, setActiveRung] = useState<0 | 1 | 2>(1);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [renderingBeatId, setRenderingBeatId] = useState<string | null>(null);
  const filterPresetIdxRef = useRef(0);

  const reviewRef = useRef<ReviewPaneRef>(null);

  // Default activeRung to current_rung once when storyboard loads.
  const lastSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (storyboard && storyboard.slug !== lastSlugRef.current) {
      setActiveRung(storyboard.current_rung as 0 | 1 | 2);
      lastSlugRef.current = storyboard.slug;
    }
  }, [storyboard]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["storyboards", id] });
    qc.invalidateQueries({ queryKey: ["storyboards"] });
  }, [qc, id]);

  const handleApprove = useCallback(
    async (beatId: string, rungKey: Rung) => {
      const rungNum = (
        ["0_beat_sheet", "1_lofi", "2_hifi"] as const
      ).indexOf(rungKey) as 0 | 1 | 2;
      await setBeatStatus({
        storyboardId: id,
        beatId,
        rung: rungNum,
        status: "approved",
      });
      invalidate();
    },
    [id, invalidate],
  );

  const handleNeedsRework = useCallback(
    async (beatId: string, rungKey: Rung) => {
      const rungNum = (
        ["0_beat_sheet", "1_lofi", "2_hifi"] as const
      ).indexOf(rungKey) as 0 | 1 | 2;
      await setBeatStatus({
        storyboardId: id,
        beatId,
        rung: rungNum,
        status: "needs-rework",
      });
      invalidate();
    },
    [id, invalidate],
  );

  const handleAddComment = useCallback(
    async (beatId: string, text: string, rung: number) => {
      await appendBeatComment({ storyboardId: id, beatId, text, rung });
      invalidate();
    },
    [id, invalidate],
  );

  const handleSendNote = useCallback(
    async (beatId: string, text: string, rung: number) => {
      // Two writes — comment + status flip — done sequentially. Order matters:
      // append comment first so the rework status is the latest event.
      await appendBeatComment({ storyboardId: id, beatId, text, rung });
      await setBeatStatus({
        storyboardId: id,
        beatId,
        rung: rung as 0 | 1 | 2,
        status: "needs-rework",
      });
      invalidate();
    },
    [id, invalidate],
  );

  const handleTweakBeat = useCallback(
    async (
      beatId: string,
      patch: {
        label?: string;
        narration_excerpt?: string;
        timeStart?: number;
        timeEnd?: number;
      },
    ) => {
      await updateBeatMeta({
        storyboardId: id,
        beatId,
        patch: {
          label: patch.label,
          narrationExcerpt:
            patch.narration_excerpt === undefined
              ? undefined
              : patch.narration_excerpt,
          timeStart: patch.timeStart,
          timeEnd: patch.timeEnd,
        },
      });
      invalidate();
    },
    [id, invalidate],
  );

  // ── Render still (Tauri shell-out + job tracking) ────────────────────────

  const handleRenderStill = useCallback(
    async (beatId: string, rung: 1 | 2) => {
      if (!storyboard) return;
      setRenderingBeatId(beatId);
      const jobId = `still-${id}-${beatId}-${rung}-${Date.now()}`;

      let unlisten: (() => void) | null = null;
      try {
        // Materialize storyboard.json before the CLI reads it.
        await storyboardExportJson(id, storyboardToJson(storyboard));

        await insertStoryboardJob({
          id: jobId,
          storyboardId: id,
          kind: "render_still",
          beatId,
          targetRung: rung,
        });
        await markJobRunning(jobId);
        invalidate();

        unlisten = await storyboardListenJob(jobId, () => {
          // Job log persistence happens inline via the markJob* helpers; the
          // listener is mostly here for future progress UI in 7.1.
        });

        const stillPath = await storyboardRenderStill({
          jobId,
          slug: id,
          beatId,
          rung,
        });

        if (stillPath) {
          await setBeatStillPath({
            storyboardId: id,
            beatId,
            rung,
            stillPath,
            status: "pending-review",
          });
        }
        await markJobComplete(jobId);
        invalidate();
      } catch (e) {
        await markJobFailed(jobId, String(e));
        invalidate();
      } finally {
        if (unlisten) unlisten();
        setRenderingBeatId(null);
      }
    },
    [id, storyboard, invalidate],
  );

  // ── Bulk approve current rung ────────────────────────────────────────────

  const handleBulkApprove = useCallback(async () => {
    if (!storyboard) return;
    const rung = storyboard.current_rung as 0 | 1 | 2;
    for (const b of storyboard.beats) {
      await setBeatStatus({
        storyboardId: id,
        beatId: b.id,
        rung,
        status: "approved",
      });
    }
    invalidate();
  }, [storyboard, id, invalidate]);

  // ── Keyboard nav ─────────────────────────────────────────────────────────

  const visibleIndexes = useMemo(() => {
    if (!storyboard) return [] as number[];
    const out: number[] = [];
    storyboard.beats.forEach((b, i) => {
      const st = b.rungs[RUNG_KEY_FROM_NUM[activeRung]].status;
      if (filters[st]) out.push(i);
    });
    return out;
  }, [storyboard, activeRung, filters]);

  const stepVisible = useCallback(
    (dir: 1 | -1) => {
      if (!storyboard || visibleIndexes.length === 0) return;
      const inFilter = visibleIndexes.indexOf(activeBeatIndex);
      let pos: number;
      if (inFilter === -1) {
        pos = dir === 1 ? 0 : visibleIndexes.length - 1;
      } else {
        pos = Math.max(
          0,
          Math.min(visibleIndexes.length - 1, inFilter + dir),
        );
      }
      setActiveBeatIndex(visibleIndexes[pos]);
    },
    [storyboard, visibleIndexes, activeBeatIndex],
  );

  const cyclePreset = useCallback((dir: 1 | -1) => {
    const next =
      (filterPresetIdxRef.current + dir + FILTER_PRESETS.length) %
      FILTER_PRESETS.length;
    filterPresetIdxRef.current = next;
    setFilters(FILTER_PRESETS[next]);
  }, []);

  const currentBeat = storyboard?.beats[activeBeatIndex];
  const currentRungKey = RUNG_KEY_FROM_NUM[activeRung];

  useKeyboard(
    {
      onPrevBeat: () => stepVisible(-1),
      onNextBeat: () => stepVisible(1),
      onPrevRung: () => setActiveRung((r) => Math.max(0, r - 1) as 0 | 1 | 2),
      onNextRung: () => setActiveRung((r) => Math.min(2, r + 1) as 0 | 1 | 2),
      onApprove: () => {
        if (currentBeat) void handleApprove(currentBeat.id, currentRungKey);
      },
      onNeedsRework: () => {
        if (currentBeat) void handleNeedsRework(currentBeat.id, currentRungKey);
      },
      onFocusComment: () => reviewRef.current?.focusComment(),
      onSendNote: () => reviewRef.current?.startSendNote(),
      onToggleTweak: () => reviewRef.current?.toggleTweak(),
      onCycleFiltersBack: () => cyclePreset(-1),
      onCycleFiltersForward: () => cyclePreset(1),
    },
    !sbQuery.isLoading,
  );

  const toggleFilter = useCallback((status: BeatStatus) => {
    setFilters((prev) => ({ ...prev, [status]: !prev[status] }));
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  if (sbQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading storyboard…
      </div>
    );
  }

  if (sbQuery.error) {
    return (
      <div className="m-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load: {String(sbQuery.error)}
      </div>
    );
  }

  if (!storyboard || !currentBeat) {
    return (
      <div className="m-6 rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
        Storyboard not found.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <RungBar
        storyboard={storyboard}
        compositionId={compositionId}
        onRefresh={() => invalidate()}
        onBulkApprove={() => void handleBulkApprove()}
      />
      <div className="flex min-h-0 flex-1">
        <BeatStrip
          storyboard={storyboard}
          activeBeatIndex={activeBeatIndex}
          activeRung={activeRung}
          filters={filters}
          onSelectBeat={setActiveBeatIndex}
          onToggleFilter={toggleFilter}
        />
        <ReviewPane
          ref={reviewRef}
          beat={currentBeat}
          beatIndex={activeBeatIndex}
          totalBeats={storyboard.beats.length}
          storyboardSlug={storyboard.slug}
          activeRung={activeRung}
          onSetActiveRung={setActiveRung}
          onApprove={handleApprove}
          onNeedsRework={handleNeedsRework}
          onAddComment={handleAddComment}
          onSendNote={handleSendNote}
          onTweakBeat={handleTweakBeat}
          onRenderStill={handleRenderStill}
          isRendering={renderingBeatId === currentBeat.id}
        />
      </div>
    </div>
  );
}

/**
 * Convert canonical Storyboard back to the JSON shape the engine CLI expects
 * (matches @/video/lib/storyboard-schema's StoryboardSchema).
 */
function storyboardToJson(sb: Storyboard): unknown {
  return {
    slug: sb.slug,
    title: sb.title,
    narration: sb.narration,
    current_rung: sb.current_rung,
    selected_concepts: sb.selected_concepts,
    selected_concepts_note: sb.selected_concepts_note,
    beats: sb.beats.map((b: StoryboardBeat) => ({
      id: b.id,
      label: b.label,
      time: b.time,
      frames: b.frames,
      narration_excerpt: b.narration_excerpt,
      intent: b.intent,
      rungs: b.rungs,
      comments: b.comments,
    })),
  };
}

// upsertBeat / updateStoryboardMeta are imported above for future agent flows
// (phase 7.1) — keep them in the import block so the editor surface area is
// visible at a glance.
void upsertBeat;
void updateStoryboardMeta;
