/**
 * Shell-out helper for subcommands that delegate to scripts in royalti-pa/scripts/.
 *
 * pa-actions is the unified cron entry point; for scripts not yet vendored
 * inline, it spawns the canonical TS script in royalti-pa/scripts/ via tsx.
 * The royalti-pa/ directory hosts the shared library + scripts after the
 * Next.js server retirement (2026-05-02). To fully vendor a delegate,
 * swap the one-liner for an inline implementation.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = process.env.REPO_ROOT ?? resolve(homedir(), "royalti-co");
const PA_DIR = resolve(REPO_ROOT, "royalti-pa");
const TSX = resolve(PA_DIR, "node_modules", ".bin", "tsx");

export interface ScriptOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runPaScript(
  scriptRelPath: string,
  args: string[] = [],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ScriptOutcome> {
  const scriptPath = resolve(PA_DIR, scriptRelPath);
  if (!existsSync(scriptPath)) {
    throw new Error(`script not found: ${scriptPath}`);
  }
  if (!existsSync(TSX)) {
    throw new Error(`tsx not found at ${TSX} — run \`pnpm install\` in royalti-pa`);
  }

  return new Promise((resolveP, reject) => {
    const child = spawn(TSX, [scriptPath, ...args], {
      cwd: PA_DIR,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`script timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
