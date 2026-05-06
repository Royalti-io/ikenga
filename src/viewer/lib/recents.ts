// Viewer recents — writes on every <ArtifactView> mount, reads via
// `useViewerRecents` for the ⌘O command palette and the inbox "Recent files"
// widget. Backed by the `viewer_recents` table (migration 0002).

import { useEffect, useState } from "react";
import { dbExec, dbQuery } from "@/lib/tauri-cmd";

export type ViewerRecentSource =
  | "chat"
  | "palette"
  | "tree"
  | "drag"
  | "pane"
  | "external";

export interface ViewerRecent {
  path: string;
  mime: string | null;
  last_opened: number;
  source: string | null;
}

/** Upsert the row for `path` with the latest mime + timestamp. Best-effort —
 * recents are a UX nicety, never a correctness signal, so we swallow errors. */
export async function recordViewerOpen(
  path: string,
  mime: string,
  source: ViewerRecentSource = "pane",
): Promise<void> {
  try {
    await dbExec(
      `INSERT INTO viewer_recents (path, mime, last_opened, source)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(path) DO UPDATE SET
         mime = excluded.mime,
         last_opened = excluded.last_opened,
         source = excluded.source`,
      [path, mime, Date.now(), source],
    );
  } catch (err) {
    console.warn("[viewer] recents write failed:", err);
  }
}

export async function listViewerRecents(limit = 50): Promise<ViewerRecent[]> {
  const rows = await dbQuery<ViewerRecent>(
    `SELECT path, mime, last_opened, source
       FROM viewer_recents
       ORDER BY last_opened DESC
       LIMIT ?1`,
    [limit],
  );
  return rows;
}

/** React hook for consumer UIs (⌘O palette, inbox widget). Refetches on
 * `version` bump — pass an effect-driven counter if you need refresh. */
export function useViewerRecents(limit = 50, version = 0): {
  recents: ViewerRecent[];
  loading: boolean;
  error: string | null;
} {
  const [recents, setRecents] = useState<ViewerRecent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listViewerRecents(limit)
      .then((rows) => {
        if (cancelled) return;
        setRecents(rows);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limit, version]);

  return { recents, loading, error };
}
