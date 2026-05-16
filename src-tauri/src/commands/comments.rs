//! Tauri commands for artifact comments (pin-mode).
//!
//! Backs the artifact-grid pane's pin overlay. A pin is a `{ artifact_path,
//! selector, text, screenshot_path, status, position }` record anchored to a
//! CSS selector inside a rendered artifact. Lifecycle: `open` →
//! `in_progress` (set by the agent via `mcp-iyke.pin_acknowledge`) → `resolved`
//! (set by user manually or by the agent via `mcp-iyke.pin_resolve`).
//!
//! Sink-routing (terminal claude vs side-pane Chat) is handled in a sibling
//! module — this one is pure persistence + lifecycle.
//!
//! Schema lives in migration 0022.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use uuid::Uuid;

use super::db::PaDb;

const VALID_STATUSES: &[&str] = &["open", "in_progress", "resolved", "stale"];
const VALID_SINKS: &[&str] = &["terminal", "sidepane", "both"];

fn validate_status(s: &str) -> Result<(), String> {
    if VALID_STATUSES.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "invalid status '{s}' (expected one of: {})",
            VALID_STATUSES.join(", ")
        ))
    }
}

fn validate_sink(s: &str) -> Result<(), String> {
    if VALID_SINKS.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "invalid sink '{s}' (expected one of: {})",
            VALID_SINKS.join(", ")
        ))
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: i64,
    #[serde(rename = "artifactPath")]
    pub artifact_path: String,
    pub selector: String,
    pub text: String,
    #[serde(rename = "screenshotPath")]
    pub screenshot_path: Option<String>,
    /// `open` | `in_progress` | `resolved` | `stale`.
    pub status: String,
    #[serde(rename = "positionX")]
    pub position_x: Option<f64>,
    #[serde(rename = "positionY")]
    pub position_y: Option<f64>,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    #[serde(rename = "openingSessionId")]
    pub opening_session_id: Option<String>,
    /// `terminal` | `sidepane` | `both` — audit field, null until routed.
    pub sink: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "acknowledgedAt")]
    pub acknowledged_at: Option<i64>,
    #[serde(rename = "resolvedAt")]
    pub resolved_at: Option<i64>,
}

type CommentRow = (
    i64,            // id
    String,         // artifact_path
    String,         // selector
    String,         // text
    Option<String>, // screenshot_path
    String,         // status
    Option<f64>,    // position_x
    Option<f64>,    // position_y
    Option<String>, // thread_id
    Option<String>, // opening_session_id
    Option<String>, // sink
    i64,            // created_at
    Option<i64>,    // acknowledged_at
    Option<i64>,    // resolved_at
);

const COMMENT_COLUMNS: &str = "id, artifact_path, selector, text, screenshot_path, \
    status, position_x, position_y, thread_id, opening_session_id, sink, \
    created_at, acknowledged_at, resolved_at";

fn row_to_comment(row: CommentRow) -> Comment {
    Comment {
        id: row.0,
        artifact_path: row.1,
        selector: row.2,
        text: row.3,
        screenshot_path: row.4,
        status: row.5,
        position_x: row.6,
        position_y: row.7,
        thread_id: row.8,
        opening_session_id: row.9,
        sink: row.10,
        created_at: row.11,
        acknowledged_at: row.12,
        resolved_at: row.13,
    }
}

#[tauri::command]
pub async fn comment_create(
    db: State<'_, Arc<PaDb>>,
    artifact_path: String,
    selector: String,
    text: String,
    screenshot_path: Option<String>,
    position_x: Option<f64>,
    position_y: Option<f64>,
) -> Result<Comment, String> {
    if artifact_path.trim().is_empty() {
        return Err("artifact_path cannot be empty".into());
    }
    if selector.trim().is_empty() {
        return Err("selector cannot be empty".into());
    }
    if text.trim().is_empty() {
        return Err("text cannot be empty".into());
    }
    let pool = db.ensure_pool().await?;
    let created_at = now_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO artifact_comments (artifact_path, selector, text, screenshot_path, \
         status, position_x, position_y, created_at) \
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id",
    )
    .bind(&artifact_path)
    .bind(&selector)
    .bind(&text)
    .bind(&screenshot_path)
    .bind(position_x)
    .bind(position_y)
    .bind(created_at)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("insert comment: {e}"))?;

    let row: CommentRow = sqlx::query_as(&format!(
        "SELECT {COMMENT_COLUMNS} FROM artifact_comments WHERE id = ?"
    ))
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("read created comment: {e}"))?;
    Ok(row_to_comment(row))
}

#[tauri::command]
pub async fn comment_get(db: State<'_, Arc<PaDb>>, id: i64) -> Result<Comment, String> {
    let pool = db.ensure_pool().await?;
    let row: CommentRow = sqlx::query_as(&format!(
        "SELECT {COMMENT_COLUMNS} FROM artifact_comments WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("read comment: {e}"))?
    .ok_or_else(|| format!("comment {id} not found"))?;
    Ok(row_to_comment(row))
}

#[tauri::command]
pub async fn comment_list(
    db: State<'_, Arc<PaDb>>,
    artifact_path: Option<String>,
    include_resolved: Option<bool>,
) -> Result<Vec<Comment>, String> {
    let pool = db.ensure_pool().await?;
    let include = include_resolved.unwrap_or(false);

    let rows: Vec<CommentRow> = match (artifact_path.as_deref(), include) {
        (Some(path), true) => sqlx::query_as(&format!(
            "SELECT {COMMENT_COLUMNS} FROM artifact_comments \
             WHERE artifact_path = ? ORDER BY created_at ASC"
        ))
        .bind(path)
        .fetch_all(&pool)
        .await,
        (Some(path), false) => sqlx::query_as(&format!(
            "SELECT {COMMENT_COLUMNS} FROM artifact_comments \
             WHERE artifact_path = ? AND status != 'resolved' \
             ORDER BY created_at ASC"
        ))
        .bind(path)
        .fetch_all(&pool)
        .await,
        (None, true) => sqlx::query_as(&format!(
            "SELECT {COMMENT_COLUMNS} FROM artifact_comments \
             ORDER BY status, created_at DESC"
        ))
        .fetch_all(&pool)
        .await,
        (None, false) => sqlx::query_as(&format!(
            "SELECT {COMMENT_COLUMNS} FROM artifact_comments \
             WHERE status != 'resolved' ORDER BY status, created_at DESC"
        ))
        .fetch_all(&pool)
        .await,
    }
    .map_err(|e| format!("list comments: {e}"))?;

    Ok(rows.into_iter().map(row_to_comment).collect())
}

/// Update the routing audit fields after the dispatcher has decided where the
/// pin went. Called by the routing dispatcher once the prompt is queued.
#[tauri::command]
pub async fn comment_record_routing(
    db: State<'_, Arc<PaDb>>,
    id: i64,
    sink: String,
    thread_id: Option<String>,
    opening_session_id: Option<String>,
) -> Result<Comment, String> {
    validate_sink(&sink)?;
    let pool = db.ensure_pool().await?;
    sqlx::query(
        "UPDATE artifact_comments \
         SET sink = ?, thread_id = COALESCE(?, thread_id), \
             opening_session_id = COALESCE(?, opening_session_id) \
         WHERE id = ?",
    )
    .bind(&sink)
    .bind(&thread_id)
    .bind(&opening_session_id)
    .bind(id)
    .execute(&pool)
    .await
    .map_err(|e| format!("record routing: {e}"))?;
    comment_get(db, id).await
}

/// Set the status. The agent uses this via mcp-iyke when transitioning to
/// `in_progress` (and stamps `acknowledged_at` on first transition) or
/// `resolved` (and stamps `resolved_at`).
#[tauri::command]
pub async fn comment_set_status(
    db: State<'_, Arc<PaDb>>,
    id: i64,
    status: String,
) -> Result<Comment, String> {
    validate_status(&status)?;
    let pool = db.ensure_pool().await?;
    let now = now_millis();

    // We stamp the transition timestamps only on the first move into each
    // state; later re-transitions (e.g. reopen → in_progress) leave the
    // earliest stamp in place for the audit trail.
    let sql = match status.as_str() {
        "in_progress" => {
            "UPDATE artifact_comments \
             SET status = 'in_progress', \
                 acknowledged_at = COALESCE(acknowledged_at, ?) \
             WHERE id = ?"
        }
        "resolved" => {
            "UPDATE artifact_comments \
             SET status = 'resolved', \
                 resolved_at = COALESCE(resolved_at, ?) \
             WHERE id = ?"
        }
        _ => "UPDATE artifact_comments SET status = ?2 WHERE id = ?1",
    };

    if status == "in_progress" || status == "resolved" {
        sqlx::query(sql)
            .bind(now)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| format!("set status: {e}"))?;
    } else {
        sqlx::query("UPDATE artifact_comments SET status = ? WHERE id = ?")
            .bind(&status)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| format!("set status: {e}"))?;
    }

    comment_get(db, id).await
}

/// Persist a base64-encoded PNG (produced by `captureToPng` on the FE) to
/// `$app_data_dir/pin-screenshots/<uuid>.png` and return the absolute path
/// for storage in `artifact_comments.screenshot_path`. The element-picker
/// captures a *cropped* PNG of the right-clicked element; this command is
/// the FE → on-disk handoff so the path can be referenced by Claude (via
/// `mcp-iyke.pin_read`) without re-decoding base64 every read.
#[tauri::command]
pub async fn pin_screenshot_write<R: Runtime>(
    app: AppHandle<R>,
    base64_png: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A. Reject anything else early so a
    // corrupt blob can't poison the screenshots dir with junk files.
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("not a PNG (bad magic)".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("pin-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{}.png", Uuid::new_v4()));
    std::fs::write(&path, &bytes).map_err(|e| format!("write png: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn comment_delete(db: State<'_, Arc<PaDb>>, id: i64) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    sqlx::query("DELETE FROM artifact_comments WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("delete comment: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_status() {
        assert!(validate_status("queued").is_err());
        assert!(validate_status("open").is_ok());
        assert!(validate_status("in_progress").is_ok());
        assert!(validate_status("resolved").is_ok());
        assert!(validate_status("stale").is_ok());
    }

    #[test]
    fn rejects_unknown_sink() {
        assert!(validate_sink("kafka").is_err());
        assert!(validate_sink("terminal").is_ok());
        assert!(validate_sink("sidepane").is_ok());
        assert!(validate_sink("both").is_ok());
    }
}
