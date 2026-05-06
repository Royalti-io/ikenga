/**
 * Delegating subcommands. Each one spawns a corresponding tsx script in
 * royalti-pa/scripts/. The wrappers normalize stdout/stderr capture and
 * exit codes into the {ok, result} shape the rest of pa-actions emits.
 *
 * To replace any of these with a fully-vendored implementation, swap the
 * one-liner for an inline impl. The registry signature stays the same.
 */

import { runPaScript } from "../lib/exec";
import { log } from "../lib/output";

interface DelegatedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function delegate(
  scriptRel: string,
  args: string[] = [],
  timeoutMs = 300_000,
): Promise<DelegatedResult> {
  const out = await runPaScript(scriptRel, args, { timeoutMs });
  if (out.stdout) log(out.stdout.split("\n").slice(0, 10).join("\n"));
  if (out.exitCode !== 0) {
    throw new Error(
      `script exited ${out.exitCode}: ${out.stderr.slice(-500) || out.stdout.slice(-500) || "no output"}`,
    );
  }
  return out;
}

export async function listmonkPoll(): Promise<DelegatedResult> {
  return delegate("scripts/poll-listmonk-campaigns.ts");
}

export async function sendScheduled(args: string[] = []): Promise<DelegatedResult> {
  return delegate("scripts/send-scheduled.ts", args);
}

export async function fundraisingSend(args: string[] = []): Promise<DelegatedResult> {
  return delegate("scripts/send-fundraising-outreach.ts", args, 600_000);
}

/**
 * email-send <draft-id> [--dry-run]
 * Delegates to send-scheduled with a single-id filter via env var.
 * (send-scheduled supports SEND_SCHEDULED_DRAFT_ID for targeted runs.)
 */
export async function emailSend(args: string[]): Promise<DelegatedResult> {
  const draftId = args[0];
  if (!draftId) throw new Error("email-send requires a draft id arg");
  return runPaScript("scripts/send-scheduled.ts", args.slice(1), {
    timeoutMs: 120_000,
    env: { SEND_SCHEDULED_DRAFT_ID: draftId },
  }).then((out) => {
    if (out.exitCode !== 0) {
      throw new Error(`send-scheduled exit ${out.exitCode}: ${out.stderr.slice(-500)}`);
    }
    return out;
  });
}

export async function sequenceAdvance(): Promise<DelegatedResult> {
  // sequence-advancer is a bash script (curl-based) — not tsx. Spawn it directly.
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const home = (await import("node:os")).homedir();
  const repoRoot = process.env.REPO_ROOT ?? path.resolve(home, "royalti-co");
  const scriptPath = path.resolve(repoRoot, "scripts/cron/sequence-advancer.sh");

  return new Promise<DelegatedResult>((resolveP, reject) => {
    const child = spawn("bash", [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sequence-advancer exit ${code}: ${stderr.slice(-500)}`));
      } else {
        resolveP({ stdout, stderr, exitCode: code });
      }
    });
    child.on("error", reject);
  });
}
