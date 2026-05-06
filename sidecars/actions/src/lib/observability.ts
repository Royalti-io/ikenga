/**
 * Write to cron_observability so every pa-actions invocation shows up on
 * /cron in the desktop, same as agent-scheduler jobs.
 */

import { supabase } from "./supabase";
import { log } from "./output";

export interface ObservabilityRecord {
  jobId: string;
  status: "ok" | "error";
  durationMs: number;
  output?: string;
  error?: string;
  triggeredBy: "cron" | "desktop" | "manual";
}

// Desktop /agent-runs page expects status ∈ {running, completed, failed}.
// Sidecar internally tracks ok|error; map at the boundary.
function toAgentRunStatus(s: "ok" | "error"): "completed" | "failed" {
  return s === "ok" ? "completed" : "failed";
}

// Desktop expects triggered_by ∈ {cron, manual, webhook}; "desktop" collapses to "manual".
function toAgentRunTrigger(t: "cron" | "desktop" | "manual"): "cron" | "manual" | "webhook" {
  return t === "desktop" ? "manual" : t;
}

export async function recordRun(rec: ObservabilityRecord): Promise<void> {
  try {
    const now = new Date().toISOString();
    await supabase()
      .from("agent_runs")
      .insert({
        agent_name: "pa-actions",
        command: rec.jobId,
        status: toAgentRunStatus(rec.status),
        output_summary: rec.output?.slice(0, 2000) ?? null,
        error_message: rec.error ?? null,
        triggered_by: toAgentRunTrigger(rec.triggeredBy),
        started_at: new Date(Date.now() - rec.durationMs).toISOString(),
        completed_at: now,
      });
  } catch (err) {
    log("observability write failed:", err instanceof Error ? err.message : String(err));
  }
}
