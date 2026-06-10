//! Tauri commands for the approve-gate run-then-pause draft queue (WP-3).
//!
//! The producer side of the approve-gate seam
//! (`plans/atelier/10-approve-gate-seam.md`; behaviour `07-fe-button-renderer.md`
//! §3.5). An approve-aware action does its work, then — instead of sending —
//! pauses by handing the shell a batch of drafts (`pa_actions_pause`). Each
//! becomes a row in `pa_action_drafts` (migration 0050) with `status='awaiting'`
//! and a `pa-action-paused` event fires. The approve-gate panel at
//! `/outbox/approvals` reads rows via `pa_actions_list`, the operator edits in
//! place (`pa_actions_update`), and on Approve & Send (after the FE's 10s undo)
//! `pa_actions_commit` flips the row to `committed` and emits
//! `pa-action-committed` — consumed by the EXTERNAL mutation worker, which
//! performs the real SMTP/Resend/Listmonk/Buffer send and writes
//! `status='sent'`. Reject → `pa_actions_reject` → `pa-action-rejected`. **The
//! shell never sends.**
//!
//! Rust stays a thin store: `payload_json` (the DraftItem + ApproveGateMeta) is
//! opaque here and parsed FE-side via `@ikenga/contract` `fromDraftItem`.
//!
//! WP-09 additions (mutation-worker event-wake bridge):
//! * `pa_actions_commit` fires a fire-and-forget POST to the daemon run-now
//!   endpoint via `agent_ops::agent_ops_run_now` after the row is committed
//!   (DEC-11 — the daemon wakes immediately; poll stays the backstop).
//! * `pa_actions_pause_inner` normalises `scheduled_at` from ISO-8601 (with
//!   `T`-separator and optional timezone offset) to SQLite UTC `YYYY-MM-DD HH:MM:SS`
//!   before INSERT, so the worker's lexical `scheduled_at <= datetime('now')`
//!   predicate is correct by construction (DEC-10 / G-07).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row as _;
use tauri::{AppHandle, Emitter, State};

use super::db::PaDb;

const COLS: &str = "id, batch_id, action_id, status, channel, payload_json, \
                    edited_json, scheduled_at, created_at, committed_at, sent_at, \
                    claimed_at, attempts, last_attempt_at, error_text, \
                    external_id, delivery_status, delivery_checked_at";

/// Active gate statuses — rows the approve-gate panel still surfaces. `sent` and
/// `rejected` are terminal and excluded from the default list. `failed` rows are
/// included so the operator can see errors and retry (WP-12 / G-09).
const ACTIVE_STATUSES: &str = "('awaiting', 'edited', 'committed', 'failed')";

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Normalise a `scheduledAt` ISO-8601 string (e.g. `"2026-06-09T07:00:00+01:00"` or
/// `"2026-06-09T07:00:00Z"`) to the UTC space-format SQLite expects for lexical date
/// comparison: `"YYYY-MM-DD HH:MM:SS"`.
///
/// SQLite's `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` in UTC. If the
/// producer inserts a raw ISO string (which uses `T` + a timezone offset), the
/// predicate `scheduled_at <= datetime('now')` is a broken lexical compare that
/// either fires immediately (offset < `T`) or never fires (offset > space). DEC-10 /
/// G-07 requires the shell to normalise at pause-time so the worker can trust the
/// column.
///
/// Behaviour:
/// * `None` → `None` (no scheduled time).
/// * Already in the space-format (`"YYYY-MM-DD HH:MM:SS"`) → returned as-is.
/// * Valid RFC 3339 / ISO 8601 with offset or `Z` → converted to UTC, formatted as
///   `"YYYY-MM-DD HH:MM:SS"`.
/// * Unparseable → original string returned unchanged (logged; the row inserts; the
///   worker's defensive parse can handle degraded inputs rather than blocking the
///   commit with a hard error).
fn normalize_scheduled_at(iso: Option<String>) -> Option<String> {
    let s = match iso {
        None => return None,
        Some(s) if s.is_empty() => return None,
        Some(s) => s,
    };

    // Fast-path: already in `"YYYY-MM-DD HH:MM:SS"` space-format (no T, no offset).
    // The SQLite datetime format is exactly 19 chars: "2026-06-09 07:00:00".
    if s.len() == 19 && !s.contains('T') && !s.contains('+') {
        return Some(s);
    }

    // Parse as RFC 3339 and convert to UTC.
    match chrono::DateTime::parse_from_rfc3339(&s) {
        Ok(dt) => {
            use chrono::TimeZone;
            let utc = chrono::Utc.from_utc_datetime(&dt.naive_utc());
            Some(utc.format("%Y-%m-%d %H:%M:%S").to_string())
        }
        Err(e) => {
            // Non-fatal: log and pass through. The row still inserts; the worker
            // performs its own defensive parse against malformed values.
            tracing::warn!(
                scheduled_at = %s,
                error = %e,
                "pa_actions_pause: failed to normalise scheduled_at — inserting raw"
            );
            Some(s)
        }
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// One draft row as returned to the FE. `payload_json` / `edited_json` are
/// opaque JSON the FE parses (DraftItem + ApproveGateMeta) to derive a
/// `PausedDraft`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaActionDraftRow {
    pub id: String,
    #[serde(rename = "batchId")]
    pub batch_id: String,
    #[serde(rename = "actionId")]
    pub action_id: String,
    /// `awaiting` | `edited` | `committed` | `sending` | `sent` | `failed` | `rejected`.
    pub status: String,
    pub channel: String,
    #[serde(rename = "payloadJson")]
    pub payload_json: String,
    #[serde(rename = "editedJson")]
    pub edited_json: Option<String>,
    #[serde(rename = "scheduledAt")]
    pub scheduled_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "committedAt")]
    pub committed_at: Option<String>,
    #[serde(rename = "sentAt")]
    pub sent_at: Option<String>,
    // ── 0051 mutation-worker columns ─────────────────────────────────────────
    #[serde(rename = "claimedAt")]
    pub claimed_at: Option<String>,
    pub attempts: i64,
    #[serde(rename = "lastAttemptAt")]
    pub last_attempt_at: Option<String>,
    #[serde(rename = "errorText")]
    pub error_text: Option<String>,
    #[serde(rename = "externalId")]
    pub external_id: Option<String>,
    #[serde(rename = "deliveryStatus")]
    pub delivery_status: Option<String>,
    #[serde(rename = "deliveryCheckedAt")]
    pub delivery_checked_at: Option<String>,
}

/// Map a raw `SqliteRow` (from `query(COLS).fetch_*`) into `PaActionDraftRow`.
///
/// We use manual column indexing rather than a tuple `FromRow` impl because the
/// 18-column COLS projection exceeds sqlx's 16-element tuple `FromRow` limit.
/// Column order must match the `COLS` constant exactly.
fn row_to_draft(r: sqlx::sqlite::SqliteRow) -> PaActionDraftRow {
    PaActionDraftRow {
        id:                 r.get(0),
        batch_id:           r.get(1),
        action_id:          r.get(2),
        status:             r.get(3),
        channel:            r.get(4),
        payload_json:       r.get(5),
        edited_json:        r.get(6),
        scheduled_at:       r.get(7),
        created_at:         r.get(8),
        committed_at:       r.get(9),
        sent_at:            r.get(10),
        claimed_at:         r.get(11),
        attempts:           r.get::<Option<i64>, _>(12).unwrap_or(0),
        last_attempt_at:    r.get(13),
        error_text:         r.get(14),
        external_id:        r.get(15),
        delivery_status:    r.get(16),
        delivery_checked_at: r.get(17),
    }
}

/// One draft in a `pa_actions_pause` batch. `payload` (DraftItem + ApproveGateMeta)
/// is stored verbatim; the FE parses it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaPauseDraftInput {
    pub id: String,
    pub channel: String,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaActionPausedEvent {
    #[serde(rename = "batchId")]
    pub batch_id: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaActionCommittedEvent {
    #[serde(rename = "draftId")]
    pub draft_id: String,
    pub channel: String,
    /// The DraftItem + ApproveGateMeta the action produced (worker sends from this).
    #[serde(rename = "payloadJson")]
    pub payload_json: String,
    /// Operator subject/body overrides, if any.
    #[serde(rename = "editedJson")]
    pub edited_json: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaActionRejectedEvent {
    #[serde(rename = "draftId")]
    pub draft_id: String,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Pause a batch of drafts (the producer hand-off). Inserts one `awaiting` row
/// per draft atomically, then emits `pa-action-paused { batchId, count }` so the
/// shell can mount the approve gate. Backs the `host.paActionsPause` verb (WP-8).
#[tauri::command]
pub async fn pa_actions_pause(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    batch_id: String,
    action_id: String,
    drafts: Vec<PaPauseDraftInput>,
) -> Result<usize, String> {
    pa_actions_pause_inner(&app, db.inner(), batch_id, action_id, drafts).await
}

/// Shared pause logic — used by the Tauri command above and the iyke bridge
/// handler (`iyke::pa_actions`), so an MCP/CLI caller (mcp-iyke `pa_actions_pause`
/// tool, WP-8) and the FE hit the exact same insert + `pa-action-paused` emit.
pub async fn pa_actions_pause_inner(
    app: &AppHandle,
    db: &Arc<PaDb>,
    batch_id: String,
    action_id: String,
    drafts: Vec<PaPauseDraftInput>,
) -> Result<usize, String> {
    if drafts.is_empty() {
        // §3.5 invariant: the gate must never surface an empty list.
        return Err("pa_actions_pause: drafts cannot be empty".into());
    }
    let pool = db.ensure_pool().await?;
    let count = drafts.len();

    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    for d in &drafts {
        let payload =
            serde_json::to_string(&d.payload).map_err(|e| format!("serialize draft payload: {e}"))?;
        sqlx::query(
            "INSERT INTO pa_action_drafts \
             (id, batch_id, action_id, status, channel, payload_json, scheduled_at) \
             VALUES (?, ?, ?, 'awaiting', ?, ?, ?)",
        )
        .bind(&d.id)
        .bind(&batch_id)
        .bind(&action_id)
        .bind(&d.channel)
        .bind(payload)
        .bind(normalize_scheduled_at(d.scheduled_at.clone()))
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert draft {}: {e}", d.id))?;
    }
    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;

    let _ = app.emit(
        "pa-action-paused",
        PaActionPausedEvent {
            batch_id: batch_id.clone(),
            count,
        },
    );
    Ok(count)
}

/// List drafts in the gate. Defaults to the active set (`awaiting`/`edited`/
/// `committed`/`failed`); pass an explicit `status` to filter (e.g. `sent`,
/// `rejected`). Uses manual `row.get(i)` mapping instead of a tuple `FromRow`
/// because the 18-column COLS projection exceeds sqlx's 16-element tuple limit.
#[tauri::command]
pub async fn pa_actions_list(
    db: State<'_, Arc<PaDb>>,
    status: Option<String>,
) -> Result<Vec<PaActionDraftRow>, String> {
    let pool = db.ensure_pool().await?;
    let rows = if let Some(s) = status.as_deref() {
        sqlx::query(&format!(
            "SELECT {COLS} FROM pa_action_drafts WHERE status = ? ORDER BY created_at ASC"
        ))
        .bind(s)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(&format!(
            "SELECT {COLS} FROM pa_action_drafts \
             WHERE status IN {ACTIVE_STATUSES} ORDER BY created_at ASC"
        ))
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| format!("list drafts: {e}"))?;
    Ok(rows.into_iter().map(row_to_draft).collect())
}

/// Persist operator inline edits (`{ subject?, body? }`) into `edited_json` and
/// move an `awaiting` row to `edited`. Only editable while in the gate.
#[tauri::command]
pub async fn pa_actions_update(
    db: State<'_, Arc<PaDb>>,
    draft_id: String,
    patch: Value,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let edited = serde_json::to_string(&patch).map_err(|e| format!("serialize patch: {e}"))?;
    let affected = sqlx::query(
        "UPDATE pa_action_drafts \
         SET edited_json = ?, \
             status = CASE WHEN status = 'awaiting' THEN 'edited' ELSE status END \
         WHERE id = ? AND status IN ('awaiting', 'edited')",
    )
    .bind(edited)
    .bind(&draft_id)
    .execute(&pool)
    .await
    .map_err(|e| format!("update draft {draft_id}: {e}"))?
    .rows_affected();
    if affected == 0 {
        return Err(format!("draft {draft_id} not found or not editable"));
    }
    Ok(())
}

/// Commit a draft (post-undo). Flips it to `committed`, stamps `committed_at`,
/// and emits `pa-action-committed` with the channel + payload for the external
/// mutation worker. The shell does NOT perform the send.
#[tauri::command]
pub async fn pa_actions_commit(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    draft_id: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT channel, payload_json, edited_json FROM pa_action_drafts \
         WHERE id = ? AND status IN ('awaiting', 'edited')",
    )
    .bind(&draft_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("read draft {draft_id}: {e}"))?;
    let (channel, payload_json, edited_json) =
        row.ok_or_else(|| format!("draft {draft_id} not found or not committable"))?;

    sqlx::query(
        "UPDATE pa_action_drafts SET status = 'committed', committed_at = datetime('now') \
         WHERE id = ?",
    )
    .bind(&draft_id)
    .execute(&pool)
    .await
    .map_err(|e| format!("commit draft {draft_id}: {e}"))?;

    let _ = app.emit(
        "pa-action-committed",
        PaActionCommittedEvent {
            draft_id: draft_id.clone(),
            channel,
            payload_json,
            edited_json,
        },
    );

    // WP-09 / DEC-11 — event-wake: POST the daemon run-now so the mutation worker
    // fires immediately (low latency; the poll backstop catches any missed wake).
    // Fire-and-forget: spawn a detached task so the commit response returns without
    // waiting for the HTTP round-trip. Failures are silent by design — an absent /
    // stale daemon.lock (`daemon_down`) or a disabled job (`disabled` / 409) both
    // degrade gracefully; the poll catches up within 60 s.
    tokio::spawn(super::agent_ops::agent_ops_run_now(
        "mutation:send-worker".to_string(),
    ));

    Ok(())
}

/// Re-queue a `failed` draft for another send attempt (WP-12 / G-09).
///
/// Flips `failed → committed`, resets `error_text` and `claimed_at` to NULL, and
/// stamps `committed_at = datetime('now')` so the mutation worker's claimable
/// predicate (`status='committed' AND scheduled_at <= now`) picks it up on its
/// next poll (or immediately via the event-wake POST).
///
/// Only operates on `failed` rows — idempotent guard: a row already committed or
/// sent cannot be retried again (the worker owns those states).
#[tauri::command]
pub async fn pa_actions_retry(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    draft_id: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let affected = sqlx::query(
        "UPDATE pa_action_drafts \
         SET status = 'committed', \
             committed_at = datetime('now'), \
             claimed_at = NULL, \
             error_text = NULL \
         WHERE id = ? AND status = 'failed'",
    )
    .bind(&draft_id)
    .execute(&pool)
    .await
    .map_err(|e| format!("retry draft {draft_id}: {e}"))?
    .rows_affected();

    if affected == 0 {
        return Err(format!("draft {draft_id} not found or not in failed state"));
    }

    // Event-wake: POST the daemon run-now so the mutation worker fires immediately.
    // Fire-and-forget — same pattern as pa_actions_commit (DEC-11).
    tokio::spawn(super::agent_ops::agent_ops_run_now(
        "mutation:send-worker".to_string(),
    ));

    let _ = app.emit(
        "pa-action-retried",
        serde_json::json!({ "draftId": draft_id }),
    );

    Ok(())
}

/// Reject a draft. Flips it to `rejected` and emits `pa-action-rejected` so the
/// producing action can terminate cleanly.
#[tauri::command]
pub async fn pa_actions_reject(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    draft_id: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let affected = sqlx::query(
        "UPDATE pa_action_drafts SET status = 'rejected' \
         WHERE id = ? AND status IN ('awaiting', 'edited', 'committed')",
    )
    .bind(&draft_id)
    .execute(&pool)
    .await
    .map_err(|e| format!("reject draft {draft_id}: {e}"))?
    .rows_affected();
    if affected == 0 {
        return Err(format!("draft {draft_id} not found or already terminal"));
    }
    let _ = app.emit(
        "pa-action-rejected",
        PaActionRejectedEvent {
            draft_id: draft_id.clone(),
        },
    );
    Ok(())
}
