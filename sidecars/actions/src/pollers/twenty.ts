/**
 * Twenty CRM poller — replaces api/webhooks/twenty-callback.
 *
 * The old webhook *received* execution results pushed by Twenty Logic Functions.
 * Polling inverts that: we ask Twenty for recent workflow runs and write them
 * to agent_runs ourselves. Twenty exposes workflow run history via the REST
 * API at /rest/workflowRuns.
 */

import { supabase } from "../lib/supabase";
import { env, envOptional } from "../lib/env";
import { log } from "../lib/output";

const LOOKBACK_MIN = 240;

interface TwentyWorkflowRun {
  id: string;
  workflowId: string;
  name?: string;
  status: string;
  output?: { result?: string };
  errorMessage?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
}

export async function runTwentyPoll(): Promise<{ scanned: number; inserted: number; errors: number }> {
  const apiUrl = envOptional("TWENTY_API_URL");
  if (!apiUrl) {
    log("twenty-poll: TWENTY_API_URL not set, skipping");
    return { scanned: 0, inserted: 0, errors: 0 };
  }

  const apiKey = env("TWENTY_API_KEY");
  const since = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
  const url = `${apiUrl.replace(/\/$/, "")}/rest/workflowRuns?filter=createdAt[gte]:${encodeURIComponent(since)}&limit=100`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    log("twenty fetch failed:", err instanceof Error ? err.message : String(err));
    return { scanned: 0, inserted: 0, errors: 1 };
  }

  if (!resp.ok) {
    log(`twenty HTTP ${resp.status}`);
    return { scanned: 0, inserted: 0, errors: 1 };
  }

  const body = (await resp.json()) as { data?: { workflowRuns?: TwentyWorkflowRun[] } };
  const runs = body.data?.workflowRuns ?? [];
  if (!runs.length) return { scanned: 0, inserted: 0, errors: 0 };

  const sb = supabase();

  // Skip ones we've already recorded — agent_runs gets a unique key on
  // (agent_name, command, completed_at) effectively via dedupe via id stash.
  const existingIds = new Set<string>();
  const { data: existing } = await sb
    .from("agent_runs")
    .select("output_summary")
    .eq("triggered_by", "twenty-crm")
    .gte("completed_at", since);
  for (const r of existing ?? []) {
    const m = (r.output_summary ?? "").match(/twenty:run:([a-f0-9-]+)/i);
    if (m) existingIds.add(m[1]);
  }

  let inserted = 0;
  let errors = 0;

  for (const run of runs) {
    if (existingIds.has(run.id)) continue;
    const status = run.status?.toLowerCase().includes("fail") ? "failed" : "completed";
    const completedAt = run.endedAt ?? run.createdAt ?? new Date().toISOString();
    const startedAt = run.startedAt ?? completedAt;
    const summary = `[twenty:run:${run.id}] ${run.output?.result ?? ""}`.slice(0, 2000);

    const { error } = await sb.from("agent_runs").insert({
      agent_name: run.workflowId,
      command: run.name ?? run.workflowId,
      status,
      output_summary: summary,
      error_message: run.errorMessage ?? null,
      triggered_by: "twenty-crm",
      started_at: startedAt,
      completed_at: completedAt,
    });
    if (error) {
      log("agent_runs insert err:", error.message);
      errors++;
    } else {
      inserted++;
    }
  }

  log(`twenty-poll: scanned=${runs.length} inserted=${inserted} errors=${errors}`);
  return { scanned: runs.length, inserted, errors };
}
