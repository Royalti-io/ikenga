/**
 * Mbox → Supabase sync engine.
 *
 * Calls the bundled `pa-mbox` sidecar to read parsed emails from local
 * Thunderbird mbox files, then bulk-upserts them into `email_messages` keyed
 * on `message_id` (the column has a UNIQUE constraint, so we use
 * `ignoreDuplicates: true` for idempotency).
 *
 * Lookback: by default reads emails received in the last
 * `DEFAULT_LOOKBACK_MS` window. The window deliberately overlaps with the
 * scheduling cadence so a delayed mbox flush doesn't drop messages — the
 * upsert handles dedup.
 */

import { mboxReadAll, type ParsedEmail } from '@/lib/tauri-cmd';
import { supabase } from '@/lib/supabase';
import { readSyncState, recordSyncFailure, recordSyncSuccess } from './sync-state';

const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const OVERLAP_MS = 30 * 60 * 1000; // re-read last 30 min to catch late deliveries
const INSERT_BATCH = 200;

export interface SyncResult {
  scanned: number;
  inserted: number;
  /** ISO timestamp recorded as the new "last sync" mark. */
  syncedAtIso: string;
}

export interface SyncOpts {
  /** Force a full lookback rather than reading from sync state. */
  fullLookback?: boolean;
  /** Restrict to specific mailbox keys (see thunderbird-reader's MAILBOX_MAP). */
  mailboxes?: string[];
}

function toRow(e: ParsedEmail): Record<string, unknown> {
  return {
    inbox_source: e.inbox_source,
    message_id: e.message_id,
    subject: e.subject,
    from_address: e.from_address,
    to_address: e.to_address,
    cc_address: e.cc_address,
    reply_to: e.reply_to,
    in_reply_to: e.in_reply_to,
    body_text: e.body_text,
    received_at: e.received_at,
  };
}

async function resolveSinceIso(opts: SyncOpts): Promise<string> {
  if (opts.fullLookback) {
    return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  }
  const state = await readSyncState();
  if (state.lastSyncIso) {
    const last = new Date(state.lastSyncIso).getTime();
    if (!isNaN(last)) {
      return new Date(last - OVERLAP_MS).toISOString();
    }
  }
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
}

/**
 * Run one mbox → Supabase sync cycle.
 *
 * On success, persists `last_sync_iso` and clears any prior error. On failure,
 * records the error message but does NOT advance `last_sync_iso` so the next
 * run retries the same window.
 */
export async function runMboxSync(opts: SyncOpts = {}): Promise<SyncResult> {
  const sinceIso = await resolveSinceIso(opts);
  const startedAt = new Date();

  let parsed: ParsedEmail[];
  try {
    parsed = await mboxReadAll({
      sinceIso,
      mailboxes: opts.mailboxes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSyncFailure(`sidecar: ${msg}`);
    throw new Error(`mbox sidecar failed: ${msg}`);
  }

  const rows = parsed.map(toRow);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const { error, count } = await supabase
      .from('email_messages')
      .upsert(chunk, {
        onConflict: 'message_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (error) {
      const msg = `${error.code ?? ''} ${error.message}`.trim();
      await recordSyncFailure(`supabase: ${msg}`);
      throw new Error(`supabase upsert failed: ${msg}`);
    }
    // `count` reflects rows actually inserted (excluding duplicates).
    inserted += count ?? 0;
  }

  const syncedAtIso = startedAt.toISOString();
  await recordSyncSuccess({ syncedAtIso, inserted });

  return {
    scanned: parsed.length,
    inserted,
    syncedAtIso,
  };
}
