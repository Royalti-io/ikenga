//! Chat-session bridge endpoints — let the iyke CLI / mcp-iyke list and
//! re-attribute Claude chat threads without touching the Tauri command
//! surface.
//!
//! Phase 3 of the projects-first-class plan. Sessions are scoped by
//! `chat_threads.project_id` (nullable, ON DELETE SET NULL). The list
//! endpoint filters by the active project by default; `include_all=true`
//! drops the filter. `move` is a metadata-only re-attribution — it does
//! NOT respawn the claude subprocess. The cwd captured at session-spawn
//! time stays whatever it was; only the row's project_id changes.

use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::commands::db::PaDb;
use crate::commands::projects::{get_active_project_id, get_project};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Serialize)]
pub struct ChatThreadRow {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub project_id: Option<String>,
    pub claude_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub include_all: Option<bool>,
    #[serde(default)]
    pub limit: Option<i64>,
}

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

fn map_err(e: String) -> (StatusCode, String) {
    let lower = e.to_lowercase();
    if lower.contains("not found") {
        err(StatusCode::NOT_FOUND, e)
    } else if lower.contains("invalid") || lower.contains("archived") {
        err(StatusCode::BAD_REQUEST, e)
    } else {
        err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}

pub async fn get_session_list(
    Extension(db): Extension<Arc<PaDb>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let include_all = q.include_all.unwrap_or(false);

    let project_filter: Option<String> = if include_all {
        None
    } else if let Some(p) = q.project_id.filter(|s| !s.is_empty()) {
        Some(p)
    } else {
        Some(get_active_project_id(&pool).await.map_err(map_err)?)
    };

    let rows = match project_filter.as_deref() {
        Some(pid) => sqlx::query(
            "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_threads
             WHERE project_id = ?
             ORDER BY updated_at DESC
             LIMIT ?",
        )
        .bind(pid)
        .bind(limit)
        .fetch_all(&pool)
        .await,
        None => sqlx::query(
            "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_threads
             ORDER BY updated_at DESC
             LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&pool)
        .await,
    }
    .map_err(|e| map_err(format!("list chat_threads: {e}")))?;

    let threads: Vec<ChatThreadRow> = rows
        .iter()
        .map(|r| ChatThreadRow {
            id: r.get("id"),
            title: r.get("title"),
            cwd: r.get("cwd"),
            project_id: r.get("project_id"),
            claude_session_id: r.get("claude_session_id"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect();

    Ok(Json(serde_json::json!({ "threads": threads })))
}

#[derive(Deserialize)]
pub struct MoveBody {
    pub thread_id: String,
    pub project_id: String,
}

pub async fn post_session_move(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<MoveBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let target = get_project(&pool, &body.project_id)
        .await
        .map_err(map_err)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("project not found: {}", body.project_id)))?;
    if target.archived_at.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("project is archived: {}", body.project_id),
        ));
    }
    let res = sqlx::query(
        "UPDATE chat_threads SET project_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&body.project_id)
    .bind(now_ms())
    .bind(&body.thread_id)
    .execute(&pool)
    .await
    .map_err(|e| map_err(format!("move chat thread: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(err(
            StatusCode::NOT_FOUND,
            format!("thread not found: {}", body.thread_id),
        ));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
