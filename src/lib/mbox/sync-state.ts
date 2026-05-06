/**
 * Persistent state for the mbox sync poller, stored in `pa.db` via the
 * existing `db_query` / `db_exec` Tauri commands. Generic key/value so future
 * pollers can reuse the table without a new migration.
 */

import { dbExec, dbQuery } from '@/lib/tauri-cmd';

export interface SyncState {
  lastSyncIso: string | null;
  lastInserted: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const KEYS = {
  lastSyncIso: 'mbox.last_sync_iso',
  lastInserted: 'mbox.last_inserted',
  lastError: 'mbox.last_error',
  lastErrorAt: 'mbox.last_error_at',
} as const;

interface Row {
  key: string;
  value: string;
}

export async function readSyncState(): Promise<SyncState> {
  const rows = await dbQuery<Row>(
    'SELECT key, value FROM mbox_sync_state WHERE key IN (?, ?, ?, ?)',
    [KEYS.lastSyncIso, KEYS.lastInserted, KEYS.lastError, KEYS.lastErrorAt],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    lastSyncIso: map.get(KEYS.lastSyncIso) ?? null,
    lastInserted: Number(map.get(KEYS.lastInserted) ?? 0),
    lastError: map.get(KEYS.lastError) ?? null,
    lastErrorAt: map.get(KEYS.lastErrorAt) ?? null,
  };
}

async function writeKey(key: string, value: string): Promise<void> {
  await dbExec(
    `INSERT INTO mbox_sync_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  );
}

async function clearKey(key: string): Promise<void> {
  await dbExec('DELETE FROM mbox_sync_state WHERE key = ?', [key]);
}

export async function recordSyncSuccess(args: {
  syncedAtIso: string;
  inserted: number;
}): Promise<void> {
  await writeKey(KEYS.lastSyncIso, args.syncedAtIso);
  await writeKey(KEYS.lastInserted, String(args.inserted));
  await clearKey(KEYS.lastError);
  await clearKey(KEYS.lastErrorAt);
}

export async function recordSyncFailure(message: string): Promise<void> {
  await writeKey(KEYS.lastError, message);
  await writeKey(KEYS.lastErrorAt, new Date().toISOString());
}
