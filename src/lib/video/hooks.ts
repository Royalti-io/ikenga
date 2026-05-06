// React hooks for the supervised video sidecars (Remotion Studio,
// HyperFrames, Storyboard). The raw Tauri-command wrappers that used to
// live here were deleted when the FE migrated to direct `pkgMcpCall`
// routing — see `src/lib/pkgs/{hyperframes,video-studio,storyboard}.ts`
// for the new helper layer.
//
// Lifecycle: each hook is owned by exactly one mounted iframe pane. On
// mount it calls `*Studio` / `openProject` / `*Storyboard`, captures the
// port, and feeds it to the iframe. On unmount it calls the corresponding
// stop helper. If two panes of the same kind mount, the second one shares
// the existing process (idempotent on the sidecar side).
//
// Crash detection now flows from the pkg-kernel supervisor's
// `pkg://lifecycle` events (see `src/lib/pkgs/lifecycle.ts`). The supervisor
// owns auto-restart; the UI just reflects whatever state it reports.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  HYPERFRAMES_PKG_ID,
  type HyperframesStarted,
  closeProject,
  listActive as listActiveHyperframesImpl,
  listProjects as listHyperframesProjectsImpl,
  openProject,
} from "@/lib/pkgs/hyperframes";
import { usePkgLifecycle, type PkgState } from "@/lib/pkgs/lifecycle";
import {
  STORYBOARD_PKG_ID,
  type StoryboardStarted,
  startStoryboard,
  stopStoryboard,
} from "@/lib/pkgs/storyboard";
import {
  VIDEO_STUDIO_PKG_ID,
  type StudioStarted,
  startStudio,
  stopStudio,
} from "@/lib/pkgs/video-studio";

export type { HyperframesStarted, StoryboardStarted, StudioStarted };

// Re-exports — call sites pull project listing alongside the hooks.
// Real implementations live in `@/lib/pkgs/hyperframes`.
export const listHyperframesProjects = listHyperframesProjectsImpl;
export const listActiveHyperframes = listActiveHyperframesImpl;

export type ServerStatus =
  | { kind: "idle" }
  | { kind: "booting" }
  | { kind: "ready"; port: number }
  | { kind: "crashed"; reason: string };

/**
 * Combine the supervisor's lifecycle state with our own port-known flag.
 * The supervisor knows whether the child is up; only our `start*` call
 * knows what port the iframe should point at. Both have to be true for
 * `ready`.
 */
function combine(lifecycle: PkgState, port: number | null): ServerStatus {
  if (lifecycle.kind === "error") {
    return { kind: "crashed", reason: lifecycle.reason };
  }
  if (lifecycle.kind === "booting" || port === null) {
    return { kind: "booting" };
  }
  return { kind: "ready", port };
}

/**
 * Boot the Remotion Studio sidecar on mount, tear down on unmount.
 *
 * The sidecar is a singleton across the app — multiple mounts share the
 * same backing process. We don't issue `stopStudio` on every unmount for
 * that reason; the caller (the iframe pane) owns lifecycle via `release()`
 * if it knows it's the last consumer.
 */
export function useVideoStudio(): {
  status: ServerStatus;
  restart: () => void;
  release: () => Promise<void>;
} {
  const [port, setPort] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const lifecycle = usePkgLifecycle(VIDEO_STUDIO_PKG_ID);

  useEffect(() => {
    const myVersion = ++versionRef.current;
    void (async () => {
      try {
        const result = await startStudio();
        if (versionRef.current !== myVersion) return;
        setPort(result.port);
        setStartError(null);
      } catch (e) {
        if (versionRef.current !== myVersion) return;
        setStartError((e as Error).message ?? String(e));
      }
    })();
  }, []);

  const status = useMemo<ServerStatus>(() => {
    if (startError) return { kind: "crashed", reason: startError };
    return combine(lifecycle, port);
  }, [lifecycle, port, startError]);

  return {
    status,
    restart: () => {
      const myVersion = ++versionRef.current;
      setPort(null);
      setStartError(null);
      void (async () => {
        try {
          await stopStudio();
          const result = await startStudio();
          if (versionRef.current !== myVersion) return;
          setPort(result.port);
        } catch (e) {
          if (versionRef.current !== myVersion) return;
          setStartError((e as Error).message ?? String(e));
        }
      })();
    },
    release: () => stopStudio(),
  };
}

/**
 * Boot the HyperFrames sidecar for a specific project. Each slug gets its
 * own preview server in the sidecar — multiple panes can hold different
 * projects concurrently. The last consumer to unmount for a given slug
 * tears down its preview server.
 */

// Module-level refcount keyed by project slug. Lives outside React state
// because multiple panes for the same slug must share the count.
const hyperframesRefcounts = new Map<string, number>();

function bumpRefcount(slug: string): number {
  const next = (hyperframesRefcounts.get(slug) ?? 0) + 1;
  hyperframesRefcounts.set(slug, next);
  return next;
}

function dropRefcount(slug: string): number {
  const current = hyperframesRefcounts.get(slug) ?? 0;
  const next = Math.max(0, current - 1);
  if (next === 0) hyperframesRefcounts.delete(slug);
  else hyperframesRefcounts.set(slug, next);
  return next;
}

export function useHyperframes(project: string | null): {
  status: ServerStatus;
  restart: () => void;
  release: () => Promise<void>;
} {
  const [port, setPort] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const versionRef = useRef(0);
  // The supervisor owns the whole hyperframes pkg; per-slug preview servers
  // live inside it. Lifecycle is therefore pkg-wide, not per-slug.
  const lifecycle = usePkgLifecycle(project ? HYPERFRAMES_PKG_ID : null);

  useEffect(() => {
    if (!project) {
      setPort(null);
      setStartError(null);
      return;
    }
    const slug = project;
    const myVersion = ++versionRef.current;
    bumpRefcount(slug);

    void (async () => {
      try {
        const result = await openProject(slug);
        if (versionRef.current !== myVersion) return;
        setPort(result.port);
        setStartError(null);
      } catch (e) {
        if (versionRef.current !== myVersion) return;
        setStartError((e as Error).message ?? String(e));
      }
    })();

    return () => {
      const remaining = dropRefcount(slug);
      // Last consumer for this slug — tear down its preview server.
      if (remaining === 0) {
        void closeProject(slug).catch(() => {
          // Best-effort cleanup; sidecar may already be gone.
        });
      }
    };
  }, [project]);

  const status = useMemo<ServerStatus>(() => {
    if (!project) return { kind: "idle" };
    if (startError) return { kind: "crashed", reason: startError };
    return combine(lifecycle, port);
  }, [lifecycle, port, startError, project]);

  return {
    status,
    restart: () => {
      if (!project) return;
      const myVersion = ++versionRef.current;
      setPort(null);
      setStartError(null);
      void (async () => {
        try {
          // Only stop OUR slug — leave any other panes' previews alone.
          await closeProject(project);
          const result = await openProject(project);
          if (versionRef.current !== myVersion) return;
          setPort(result.port);
        } catch (e) {
          if (versionRef.current !== myVersion) return;
          setStartError((e as Error).message ?? String(e));
        }
      })();
    },
    release: () => closeProject(project),
  };
}

/**
 * Boot the Storyboard sidecar (Vite + Express dev pair) on mount. Same
 * lifecycle shape as `useVideoStudio` — single instance shared across the
 * app, idempotent start, restart resets the port.
 */
export function useStoryboard(): {
  status: ServerStatus;
  restart: () => void;
  release: () => Promise<void>;
} {
  const [port, setPort] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const lifecycle = usePkgLifecycle(STORYBOARD_PKG_ID);

  useEffect(() => {
    const myVersion = ++versionRef.current;
    void (async () => {
      try {
        const result = await startStoryboard();
        if (versionRef.current !== myVersion) return;
        setPort(result.port);
        setStartError(null);
      } catch (e) {
        if (versionRef.current !== myVersion) return;
        setStartError((e as Error).message ?? String(e));
      }
    })();
  }, []);

  const status = useMemo<ServerStatus>(() => {
    if (startError) return { kind: "crashed", reason: startError };
    return combine(lifecycle, port);
  }, [lifecycle, port, startError]);

  return {
    status,
    restart: () => {
      const myVersion = ++versionRef.current;
      setPort(null);
      setStartError(null);
      void (async () => {
        try {
          await stopStoryboard();
          const result = await startStoryboard();
          if (versionRef.current !== myVersion) return;
          setPort(result.port);
        } catch (e) {
          if (versionRef.current !== myVersion) return;
          setStartError((e as Error).message ?? String(e));
        }
      })();
    },
    release: () => stopStoryboard(),
  };
}
