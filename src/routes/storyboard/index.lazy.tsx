import { useEffect, useState } from "react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { storyboardSummariesQueryOptions } from "@/lib/queries/storyboard/storyboards";
import {
  ensureFixturesImported,
  type ImportReport,
} from "@/lib/storyboard/import";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createLazyFileRoute("/storyboard/")({
  component: StoryboardIndex,
});

const RUNG_LABELS = ["Beat Sheet", "Lo-fi", "Hi-fi"] as const;
const RUNG_COLOR = [
  "text-muted-foreground",
  "text-amber-700 dark:text-amber-400",
  "text-emerald-700 dark:text-emerald-400",
] as const;

function StoryboardIndex() {
  const summaries = useQuery(storyboardSummariesQueryOptions());
  const qc = useQueryClient();
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [importing, setImporting] = useState(false);

  // Auto-import fixtures on first load if no storyboards exist.
  useEffect(() => {
    if (summaries.data && summaries.data.length === 0 && !importing && !importReport) {
      setImporting(true);
      ensureFixturesImported()
        .then((r) => setImportReport(r))
        .catch((e) => setImportReport({ imported: [], skipped: [{ slug: "?", reason: String(e) }] }))
        .finally(() => {
          setImporting(false);
          qc.invalidateQueries({ queryKey: ["storyboards"] });
        });
    }
  }, [summaries.data, importing, importReport, qc]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Clapperboard className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Storyboards</h1>
          <span className="text-sm text-muted-foreground">
            ({summaries.data?.length ?? 0})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setImportReport(null);
              setImporting(true);
              ensureFixturesImported()
                .then((r) => setImportReport(r))
                .catch((e) =>
                  setImportReport({
                    imported: [],
                    skipped: [{ slug: "?", reason: String(e) }],
                  }),
                )
                .finally(() => {
                  setImporting(false);
                  qc.invalidateQueries({ queryKey: ["storyboards"] });
                });
            }}
            disabled={importing}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {importing ? "Importing…" : "Import fixtures"}
          </Button>
          <Button size="sm" disabled title="Manual create — phase 7.1">
            <Plus className="mr-1 h-4 w-4" />
            New
          </Button>
        </div>
      </header>

      {importReport && (importReport.imported.length > 0 || importReport.skipped.length > 0) && (
        <div className="border-b border-border bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
          {importReport.imported.length > 0 && (
            <span className="text-emerald-700 dark:text-emerald-400">
              Imported: {importReport.imported.join(", ")}
            </span>
          )}
          {importReport.imported.length > 0 && importReport.skipped.length > 0 && " · "}
          {importReport.skipped.length > 0 && (
            <span>
              Skipped:{" "}
              {importReport.skipped
                .map((s) => `${s.slug} (${s.reason})`)
                .join(", ")}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4">
        {summaries.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {summaries.data && summaries.data.length === 0 && !importing && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No storyboards yet. Click "Import fixtures" to load <code>ask-roy</code>{" "}
            and <code>ask-roy-v2</code> from the engine repo, or create one via
            agent flow (phase 7.1).
          </div>
        )}
        {summaries.data && summaries.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {summaries.data.map((s) => {
              const pct =
                s.beats_total > 0
                  ? Math.round((s.beats_approved / s.beats_total) * 100)
                  : 0;
              return (
                <li key={s.id}>
                  <Link
                    to="/storyboard/$id"
                    params={{ id: s.id }}
                    className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                          <h2 className="truncate text-sm font-semibold">
                            {s.title}
                          </h2>
                          <span className="font-mono text-xs text-muted-foreground">
                            {s.id}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated {new Date(s.updated_at).toLocaleString()}
                          {s.composition_id && (
                            <>
                              {" · "}
                              <span className="font-mono">{s.composition_id}</span>
                            </>
                          )}
                        </p>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div
                            className={`text-sm font-semibold ${RUNG_COLOR[s.current_rung]}`}
                          >
                            Rung {s.current_rung}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {RUNG_LABELS[s.current_rung]}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold tabular-nums">
                            {s.beats_approved}/{s.beats_total}
                          </div>
                          <div className="text-xs text-muted-foreground">approved</div>
                        </div>
                        <div className="w-20">
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-emerald-500 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="mt-0.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                            {pct}%
                          </div>
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
