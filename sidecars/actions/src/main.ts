/**
 * pa-actions sidecar — dual-mode entry point.
 *
 *   One-shot CLI mode (cron / Tauri shell):
 *     pa-actions <subcommand> [--once] [--json] [args...]
 *
 *   Daemon mode (long-running, JSON-RPC over stdio for Tauri):
 *     pa-actions --daemon
 *
 * Subcommands are dispatched to handlers registered in REGISTRY. Each
 * handler is an async function returning a JSON-serialisable result. The
 * runner wraps it in an Outcome envelope and writes to cron_observability.
 */

import { runResendPoll } from "./pollers/resend";
import { runTwentyPoll } from "./pollers/twenty";
import {
  emailSend,
  fundraisingSend,
  listmonkPoll,
  sendScheduled,
  sequenceAdvance,
} from "./mutations/delegated";
import { replySend } from "./mutations/reply-send";
import { crmLookup } from "./lookups/crm-lookup";
import { assertRequired } from "./lib/env";
import { emitOutcome, log } from "./lib/output";
import { recordRun } from "./lib/observability";

type Handler = (args: string[]) => Promise<unknown>;

// Subcommands either run inline (pollers) or delegate to royalti-pa/scripts/
// (mutations). Delegating keeps the migration fast — porting every script
// inline would be a multi-day exercise. Each delegated subcommand can be
// replaced with a vendored impl later without changing the registry signature.
const REGISTRY: Record<string, Handler> = {
  "resend-poll": async () => runResendPoll(),
  "twenty-poll": async () => runTwentyPoll(),
  "listmonk-poll": async () => listmonkPoll(),
  "send-scheduled": async (args) => sendScheduled(args),
  "fundraising-send": async (args) => fundraisingSend(args),
  "email-send": async (args) => emailSend(args),
  "reply-send": async (args) => replySend(args),
  "sequence-advance": async () => sequenceAdvance(),
  "crm-lookup": async (args) => crmLookup(args),
};

async function runOnce(subcommand: string, args: string[], triggeredBy: "cron" | "desktop" | "manual"): Promise<number> {
  const handler = REGISTRY[subcommand];
  if (!handler) {
    emitOutcome({
      ok: false,
      subcommand,
      durationMs: 0,
      error: `unknown subcommand: ${subcommand} — known: ${Object.keys(REGISTRY).join(", ")}`,
    });
    return 2;
  }

  const start = Date.now();
  try {
    assertRequired();
    const result = await handler(args);
    const durationMs = Date.now() - start;
    emitOutcome({ ok: true, subcommand, durationMs, result });
    await recordRun({
      jobId: subcommand,
      status: "ok",
      durationMs,
      output: JSON.stringify(result).slice(0, 2000),
      triggeredBy,
    });
    return 0;
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.stack ?? err.message : String(err);
    emitOutcome({ ok: false, subcommand, durationMs, error });
    await recordRun({
      jobId: subcommand,
      status: "error",
      durationMs,
      error,
      triggeredBy,
    });
    return 1;
  }
}

interface DaemonRequest {
  id?: string;
  subcommand?: string;
  args?: string[];
}

async function runDaemon(): Promise<void> {
  log(`daemon started (pid=${process.pid})`);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let req: DaemonRequest;
      try {
        req = JSON.parse(line) as DaemonRequest;
      } catch {
        process.stdout.write(JSON.stringify({ id: "", ok: false, error: "invalid JSON" }) + "\n");
        continue;
      }

      const sub = req.subcommand ?? "";
      const id = req.id ?? "";
      const args = req.args ?? [];
      const handler = REGISTRY[sub];
      if (!handler) {
        process.stdout.write(JSON.stringify({ id, ok: false, error: `unknown subcommand: ${sub}` }) + "\n");
        continue;
      }
      const start = Date.now();
      try {
        const result = await handler(args);
        const durationMs = Date.now() - start;
        process.stdout.write(JSON.stringify({ id, ok: true, subcommand: sub, durationMs, result }) + "\n");
        await recordRun({
          jobId: sub,
          status: "ok",
          durationMs,
          output: JSON.stringify(result).slice(0, 2000),
          triggeredBy: "desktop",
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        const error = err instanceof Error ? err.message : String(err);
        process.stdout.write(JSON.stringify({ id, ok: false, subcommand: sub, durationMs, error }) + "\n");
        await recordRun({ jobId: sub, status: "error", durationMs, error, triggeredBy: "desktop" });
      }
    }
  }
  log("stdin closed — daemon exiting");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    process.stderr.write("usage: pa-actions <subcommand> [args...] | pa-actions --daemon\n");
    process.stderr.write(`subcommands: ${Object.keys(REGISTRY).join(", ")}\n`);
    process.exit(2);
  }

  if (argv[0] === "--daemon") {
    await runDaemon();
    return;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);
  // --triggered-by=cron|desktop|manual; default cron when stdin is non-tty
  let triggeredBy: "cron" | "desktop" | "manual" = process.stdin.isTTY ? "manual" : "cron";
  const tbIdx = rest.indexOf("--triggered-by");
  if (tbIdx !== -1 && rest[tbIdx + 1]) {
    const v = rest[tbIdx + 1];
    if (v === "cron" || v === "desktop" || v === "manual") triggeredBy = v;
    rest.splice(tbIdx, 2);
  }
  const exitCode = await runOnce(subcommand, rest, triggeredBy);
  process.exit(exitCode);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
