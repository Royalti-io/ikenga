import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  renderCancel,
  renderComposition,
  renderListen,
  type RenderEvent,
} from "@/lib/tauri-cmd";
import {
  insertRenderJob,
  markCancelled,
  markComplete,
  markFailed,
  markRunning,
  renderJobsQueryKey,
  setProgress,
} from "@/lib/queries/video/render-jobs";

export type RenderStatus =
  | "idle"
  | "starting"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface RenderState {
  jobId: string | null;
  status: RenderStatus;
  /** 0..1, or null while we have no progress signal yet. */
  progress: number | null;
  outputPath: string | null;
  error: string | null;
  /** Last 100 log lines, oldest first. */
  log: string[];
}

const INITIAL: RenderState = {
  jobId: null,
  status: "idle",
  progress: null,
  outputPath: null,
  error: null,
  log: [],
};

const LOG_TAIL = 100;
/** Throttle DB progress writes to once per this many ms. */
const PROGRESS_DB_INTERVAL_MS = 250;

/**
 * One-render-at-a-time hook. Mirrors lifecycle events into the render_jobs
 * SQLite table so the queue UI can show concurrent jobs and history across
 * navigation + app restart.
 */
export function useRender() {
  const [state, setState] = useState<RenderState>(INITIAL);
  const unlistenRef = useRef<(() => void) | null>(null);
  const lastProgressWriteRef = useRef(0);
  const qc = useQueryClient();
  const invalidateQueue = useCallback(() => {
    qc.invalidateQueries({ queryKey: renderJobsQueryKey });
  }, [qc]);

  // Always release the listener on unmount or when a new run starts.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (compositionId: string, props: unknown, outputPath: string) => {
      // Detach any previous listener.
      unlistenRef.current?.();
      unlistenRef.current = null;
      lastProgressWriteRef.current = 0;
      setState({ ...INITIAL, status: "starting" });

      let jobId: string;
      try {
        jobId = await renderComposition(compositionId, props, outputPath);
      } catch (err) {
        setState({
          ...INITIAL,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Persist the row eagerly so the queue UI sees it immediately. We insert
      // as 'queued' because the process may not have spawned yet (the Started
      // event flips it to 'running').
      try {
        await insertRenderJob({ id: jobId, compositionId, props, outputPath });
        invalidateQueue();
      } catch (err) {
        // DB failures are non-fatal for the in-flight render — log and move on.
        console.error("render_jobs insert failed:", err);
      }

      setState((s) => ({ ...s, jobId, status: "running" }));

      const unlisten = await renderListen(jobId, (event) => {
        setState((s) => applyEvent(s, event));
        void persistEvent(jobId, event, lastProgressWriteRef, invalidateQueue);
      });
      unlistenRef.current = unlisten;
    },
    [invalidateQueue],
  );

  const cancel = useCallback(async () => {
    setState((s) => {
      if (!s.jobId) return s;
      void renderCancel(s.jobId);
      return s; // status flips to "cancelled" when the event arrives
    });
  }, []);

  const reset = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    setState(INITIAL);
  }, []);

  return { state, start, cancel, reset };
}

function applyEvent(state: RenderState, event: RenderEvent): RenderState {
  switch (event.kind) {
    case "started":
      return { ...state, status: "running" };
    case "progress":
      return { ...state, progress: event.value };
    case "log": {
      const log = [...state.log, event.line];
      if (log.length > LOG_TAIL) log.splice(0, log.length - LOG_TAIL);
      return { ...state, log };
    }
    case "complete":
      return { ...state, status: "complete", outputPath: event.outputPath, progress: 1 };
    case "error":
      return { ...state, status: "error", error: event.message };
    case "cancelled":
      return { ...state, status: "cancelled" };
  }
}

async function persistEvent(
  jobId: string,
  event: RenderEvent,
  lastProgressRef: React.MutableRefObject<number>,
  invalidate: () => void,
): Promise<void> {
  try {
    switch (event.kind) {
      case "started":
        await markRunning(jobId);
        invalidate();
        break;
      case "progress": {
        const now = Date.now();
        if (now - lastProgressRef.current < PROGRESS_DB_INTERVAL_MS) return;
        lastProgressRef.current = now;
        await setProgress(jobId, event.value);
        // Don't invalidate here — polling picks it up. Avoids re-render storms.
        break;
      }
      case "complete":
        await markComplete(jobId, event.outputPath);
        invalidate();
        break;
      case "error":
        await markFailed(jobId, event.message);
        invalidate();
        break;
      case "cancelled":
        await markCancelled(jobId);
        invalidate();
        break;
      // log events stay in-memory only — sqlite isn't a log store.
    }
  } catch (err) {
    console.error("render_jobs persist failed:", err);
  }
}

/**
 * Default output path for a one-off render: drop into the engine's
 * gitignored output dir so the path is allowlisted and discoverable.
 */
export function defaultOutputPath(compositionId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `~/royalti-co/royalti-video-engine/output/videos/${compositionId}-${stamp}.mp4`;
}
