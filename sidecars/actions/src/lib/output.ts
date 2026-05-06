/**
 * Output helpers. The sidecar runs in two modes:
 *   - daemon (via Tauri): stdout = JSON-RPC frames, stderr = logs
 *   - one-shot CLI (via cron): stdout = JSON result, stderr = logs, exit code = status
 *
 * Both modes route logs to stderr so they don't pollute structured stdout.
 */

export function log(...args: unknown[]): void {
  process.stderr.write(`[pa-actions] ${args.map(String).join(" ")}\n`);
}

export type Outcome = {
  ok: boolean;
  subcommand: string;
  durationMs: number;
  result?: unknown;
  error?: string;
};

export function emitOutcome(outcome: Outcome): void {
  process.stdout.write(JSON.stringify(outcome) + "\n");
}

export function emitFrame(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
