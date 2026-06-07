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

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::db::PaDb;

const COLS: &str = "id, batch_id, action_id, status, channel, payload_json, \
                    edited_json, scheduled_at, created_at, committed_at, sent_at";

/// Active gate statuses — rows the approve-gate panel still surfaces. `sent` and
/// `rejected` are terminal and excluded from the default list.
const ACTIVE_STATUSES: &str = "('awaiting', 'edited', 'committed')";

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
    /// `awaiting` | `edited` | `committed` | `sent` | `rejected`.
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
}

type DraftRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

fn row_to_draft(r: DraftRow) -> PaActionDraftRow {
    PaActionDraftRow {
        id: r.0,
        batch_id: r.1,
        action_id: r.2,
        status: r.3,
        channel: r.4,
        payload_json: r.5,
        edited_json: r.6,
        scheduled_at: r.7,
        created_at: r.8,
        committed_at: r.9,
        sent_at: r.10,
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
        .bind(&d.scheduled_at)
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
/// `committed`); pass an explicit `status` to filter (e.g. `sent`, `rejected`).
#[tauri::command]
pub async fn pa_actions_list(
    db: State<'_, Arc<PaDb>>,
    status: Option<String>,
) -> Result<Vec<PaActionDraftRow>, String> {
    let pool = db.ensure_pool().await?;
    let rows: Vec<DraftRow> = if let Some(s) = status.as_deref() {
        sqlx::query_as(&format!(
            "SELECT {COLS} FROM pa_action_drafts WHERE status = ? ORDER BY created_at ASC"
        ))
        .bind(s)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query_as(&format!(
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
