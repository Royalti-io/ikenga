/**
 * "Refresh now" button for pages backed by pollers (resend-poll, twenty-poll).
 *
 * Fires the named subcommand against the pa-actions sidecar, surfaces the
 * outcome as a toast, and invalidates the listed react-query keys so the
 * page re-renders with the freshly-pulled data.
 */

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { paActionsRun, type PaActionsSubcommand } from "@/lib/tauri-cmd";

interface Props {
  subcommand: PaActionsSubcommand;
  label?: string;
  invalidateKeys?: string[][];
}

export function PaActionsRefreshButton({
  subcommand,
  label = "Refresh",
  invalidateKeys = [],
}: Props) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  async function handleClick() {
    if (running) return;
    setRunning(true);
    setLastError(null);
    try {
      const outcome = await paActionsRun(subcommand);
      if (!outcome.ok) {
        setLastError(outcome.error ?? "unknown error");
      } else {
        for (const key of invalidateKeys) {
          await qc.invalidateQueries({ queryKey: key });
        }
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={handleClick}
        disabled={running}
        title={`Run pa-actions ${subcommand}`}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
        <span className="ml-1.5">{running ? "Refreshing…" : label}</span>
      </Button>
      {lastError && (
        <span className="text-xs text-red-600" title={lastError}>
          ⚠ {lastError.slice(0, 60)}
        </span>
      )}
    </div>
  );
}
