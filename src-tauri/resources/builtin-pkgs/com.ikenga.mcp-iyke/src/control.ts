// control.json discovery + stale-file handling for the Iyke MCP server.
// Mirrors `iyke-cli/src/control.rs` so an MCP call has the same trust
// boundary as a CLI invocation: same path, same identifier, same stale
// threshold. Keep these two in sync if either changes.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const APP_IDENTIFIER = 'app.ikenga';
export const STALE_THRESHOLD_SECS = 5 * 60;

export interface ControlFile {
  schema_version: number;
  port: number;
  token: string;
  pid: number;
  started_at_unix_ms: number;
  identifier: string;
}

export type LoadOutcome =
  | { kind: 'ok'; control: ControlFile }
  | { kind: 'missing' }
  | { kind: 'stale-removed' }
  | { kind: 'stale-young'; ageSecs: number };

/**
 * Compute the same `app_local_data_dir().join("control.json")` Tauri does.
 * macOS: ~/Library/Application Support/<id>/control.json
 * Linux: $XDG_DATA_HOME/<id>/control.json (defaulting to ~/.local/share).
 */
export function controlPath(): string {
  const home = homedir();
  const plat = platform();
  let base: string;
  if (plat === 'darwin') {
    base = join(home, 'Library', 'Application Support');
  } else if (plat === 'linux') {
    base = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  } else {
    // Windows / other — best effort. Tauri uses %APPDATA%/<id> there.
    base = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  }
  return join(base, APP_IDENTIFIER, 'control.json');
}

export function load(): LoadOutcome {
  const path = controlPath();
  if (!existsSync(path)) return { kind: 'missing' };

  let cf: ControlFile;
  try {
    const raw = readFileSync(path, 'utf8');
    cf = JSON.parse(raw) as ControlFile;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  if (cf.schema_version !== 1) {
    throw new Error(
      `unsupported control.json schema_version: ${cf.schema_version} (MCP built for v1)`,
    );
  }

  if (isPidAlive(cf.pid)) {
    return { kind: 'ok', control: cf };
  }

  const ageMs = Date.now() - cf.started_at_unix_ms;
  const ageSecs = Math.floor(ageMs / 1000);
  if (ageSecs >= STALE_THRESHOLD_SECS) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort — next launch overwrites it anyway.
    }
    return { kind: 'stale-removed' };
  }
  return { kind: 'stale-young', ageSecs };
}

function isPidAlive(pid: number): boolean {
  // process.kill(pid, 0) on Unix tests existence without delivering a
  // signal. Throws ESRCH if the process is gone, EPERM if it exists but
  // we can't signal it (still alive). Windows: kill is a no-op for
  // signal 0; assume alive (CLI mirrors this).
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}
