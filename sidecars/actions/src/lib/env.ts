/**
 * Env loader. Tries paths in order:
 *   1. PA_ACTIONS_ENV_FILE (explicit override)
 *   2. $XDG_RUNTIME_DIR/pa-actions/env-vault   (Phase 14: written by the
 *      desktop app from Stronghold while it's running; chmod 600)
 *      On macOS, $TMPDIR/pa-actions/env-vault is used instead.
 *   3. ~/.config/pa-actions/env       (cron mode, chmod 600)
 *   4. royalti-pa/.env            (fallback during transition)
 *
 * Earlier candidates win — so the env-vault file populated by the running
 * desktop app overrides on-disk dotenv. Sidecars launched by cron without
 * the desktop app running fall through to (3).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, platform, tmpdir } from "node:os";

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
] as const;

const OPTIONAL = [
  "TWENTY_API_URL",
  "TWENTY_API_KEY",
  "LISTMONK_API_URL",
  "LISTMONK_USERNAME",
  "LISTMONK_PASSWORD",
  "MM_CHANNEL_PA",
  "MM_CHANNEL_ALERTS",
  "RUBY_IMAP_HOST",
  "RUBY_IMAP_USER",
  "RUBY_IMAP_PASS",
  "RUBY_SMTP_PORT",
  // Royalti production DB (GCP Cloud SQL) — used by crm-lookup to enrich
  // Reply Intelligence with tenant / health / catalog. All optional; the
  // sidecar falls back to reading royalti-server-v2.6/.env when these
  // aren't set.
  "ROYALTI_PG_HOST",
  "ROYALTI_PG_PORT",
  "ROYALTI_PG_USER",
  "ROYALTI_PG_PASSWORD",
  "ROYALTI_PG_DATABASE",
] as const;

type EnvKey = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number] | "NEXT_PUBLIC_SUPABASE_URL";

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let loaded = false;
function load(): void {
  if (loaded) return;
  loaded = true;

  const runtimeBase =
    platform() === "darwin"
      ? process.env.TMPDIR ?? tmpdir()
      : process.env.XDG_RUNTIME_DIR ?? "/tmp";
  const candidates = [
    process.env.PA_ACTIONS_ENV_FILE,
    resolve(runtimeBase, "ikenga-actions", "env-vault"),
    resolve(homedir(), ".config", "ikenga-actions", "env"),
    resolve(homedir(), "royalti-co", "royalti-pa", ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = parseDotenv(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v;
    }
  }

  // Normalize SUPABASE_URL: ikenga uses NEXT_PUBLIC_SUPABASE_URL.
  if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
}

export function env(key: EnvKey): string {
  load();
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

export function envOptional(key: EnvKey): string | undefined {
  load();
  return process.env[key];
}

export function assertRequired(): void {
  load();
  const missing = REQUIRED.filter((k) => !process.env[k] && !(k === "SUPABASE_URL" && process.env.NEXT_PUBLIC_SUPABASE_URL));
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(", ")}`);
  }
}
