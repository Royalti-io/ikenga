/**
 * Cursor store with two backends:
 *   1. Supabase pa_actions_cursor table (preferred — visible across machines).
 *   2. Local file at ~/.cache/pa-actions/cursors.json (fallback when the
 *      table doesn't exist yet, e.g. before migration 058 is applied).
 *
 * The table backend transparently falls back to the file when the table is
 * missing (Postgres error 42P01). On every successful read+write the file
 * mirror is updated too so a later table-add doesn't re-process the
 * pre-table window.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { supabase } from "./supabase";
import { log } from "./output";

const FILE_PATH = resolve(homedir(), ".cache", "pa-actions", "cursors.json");

function readFile(): Record<string, Record<string, string>> {
  if (!existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FILE_PATH, "utf8")) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function writeFileMirror(jobId: string, key: string, value: string): void {
  const all = readFile();
  if (!all[jobId]) all[jobId] = {};
  all[jobId][key] = value;
  try {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (err) {
    log("cursor file write failed:", err instanceof Error ? err.message : String(err));
  }
}

export async function getCursor(jobId: string, key: string): Promise<string | null> {
  try {
    const { data, error } = await supabase()
      .from("pa_actions_cursor")
      .select("value")
      .eq("job_id", jobId)
      .eq("key", key)
      .maybeSingle<{ value: string }>();
    if (error) {
      if (error.code === "42P01") {
        return readFile()[jobId]?.[key] ?? null;
      }
      log("cursor get error:", error.message);
      return readFile()[jobId]?.[key] ?? null;
    }
    if (data?.value) return data.value;
  } catch (err) {
    log("cursor get exception:", err instanceof Error ? err.message : String(err));
  }
  return readFile()[jobId]?.[key] ?? null;
}

export async function setCursor(jobId: string, key: string, value: string): Promise<void> {
  writeFileMirror(jobId, key, value);
  try {
    const { error } = await supabase()
      .from("pa_actions_cursor")
      .upsert(
        { job_id: jobId, key, value, updated_at: new Date().toISOString() },
        { onConflict: "job_id,key" },
      );
    if (error && error.code !== "42P01") {
      log("cursor set error:", error.message);
    }
  } catch (err) {
    log("cursor set exception:", err instanceof Error ? err.message : String(err));
  }
}
