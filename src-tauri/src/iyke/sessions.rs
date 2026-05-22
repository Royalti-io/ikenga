//! Chat-session bridge endpoints — let the iyke CLI / mcp-iyke list and
//! re-attribute Claude chat threads without touching the Tauri command
//! surface.
//!
//! Phase 3 of the projects-first-class plan. Sessions are scoped by
//! `chat_sessions.project_id` (nullable, ON DELETE SET NULL). The list
//! endpoint filters by the active project by default; `include_all=true`
//! drops the filter. `move` is a metadata-only re-attribution — it does
//! NOT respawn the claude subprocess. The cwd captured at session-spawn
//! time stays whatever it was; only the row's project_id changes.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{
    ContentBlock, Meta, NewSessionRequest, PromptRequest, SessionId, TextContent,
};
use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tauri::{AppHandle, Manager};

use crate::engines::claude_code::server::ClaudeCodeEngineState;
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
        Some(pid) => {
            sqlx::query(
                "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_sessions
             WHERE project_id = ?
             ORDER BY updated_at DESC
             LIMIT ?",
            )
            .bind(pid)
            .bind(limit)
            .fetch_all(&pool)
            .await
        }
        None => {
            sqlx::query(
                "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_sessions
             ORDER BY updated_at DESC
             LIMIT ?",
            )
            .bind(limit)
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|e| map_err(format!("list chat_sessions: {e}")))?;

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
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                format!("project not found: {}", body.project_id),
            )
        })?;
    if target.archived_at.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("project is archived: {}", body.project_id),
        ));
    }
    let res = sqlx::query("UPDATE chat_sessions SET project_id = ?, updated_at = ? WHERE id = ?")
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

#[derive(Deserialize)]
pub struct StartBody {
    pub project_id: String,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    /// Optional cwd override. If omitted the ACP server uses the project's
    /// `root_path` (or $HOME as a final fallback). Almost always omitted —
    /// the point of starting a session "in a project" is to inherit its
    /// root.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Phase 5 carry-forward (`iyke_session_start_in_project` from the
/// Phase 3 spec). Mints a thread id, validates the project, and invokes
/// the in-process `ClaudeCodeEngineState::handle_new_session` — same code path
/// the Tauri command `acp_new_session` uses, so all Phase 3+4+5 wiring
/// (project resolution, claude config-dir overlay, env vars) applies.
///
/// WP-17: when `initial_prompt` is supplied, the route now also **drives the
/// first turn** — it builds a `PromptRequest` and hands it to
/// `handle_prompt` on a spawned task, giving CLI / scheduled-routine callers
/// the same seed-and-go behaviour the in-iframe `startSeededChat` path has.
/// The turn runs in the background and streams to `chat://session/{thread_id}`
/// like any other turn, so the route returns the thread id promptly rather
/// than blocking for the full model response. `initial_prompt_sent` in the
/// response reports whether a turn was kicked off.
pub async fn post_session_start(
    Extension(db): Extension<Arc<PaDb>>,
    Extension(app): Extension<AppHandle>,
    Json(body): Json<StartBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let project = get_project(&pool, &body.project_id)
        .await
        .map_err(map_err)?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                format!("project not found: {}", body.project_id),
            )
        })?;
    if project.archived_at.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("project is archived: {}", body.project_id),
        ));
    }

    // Mint a thread id (uuid v4). The ACP server expects the caller to
    // supply one via `_meta.threadId`; the FE's new-session composer
    // mints them too. Use the timestamp+random formulation that
    // `iyke::auth::random_token_hex` provides if it exists, otherwise
    // a uuid.
    let thread_id = uuid::Uuid::new_v4().to_string();

    let cwd = body
        .cwd
        .clone()
        .or_else(|| project.root_path.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));

    // Build the NewSessionRequest with _meta.projectId + _meta.threadId
    // so the server's `resolve_project_id` + `resolve_thread_id` pick
    // them up. mcp_servers stays empty — Phase 5's per-session overlay
    // dir + CLAUDE_CONFIG_DIR injection takes care of the merged MCP set.
    let meta_value = serde_json::json!({
        "threadId": thread_id,
        "projectId": body.project_id,
    });
    let meta: Option<Meta> = serde_json::from_value(meta_value).ok();
    let mut req = NewSessionRequest::new(PathBuf::from(&cwd));
    req.meta = meta;

    let state = app.state::<ClaudeCodeEngineState>();
    state
        .handle_new_session(app.clone(), req)
        .await
        .map_err(map_err)?;

    // WP-17: actually send the initial prompt instead of just echoing it.
    // `handle_prompt` blocks until the turn completes (it loops on the event
    // stream until `Done`), so spawn it — the route returns the thread id now
    // and the turn streams to `chat://session/{thread_id}` in the background,
    // exactly as a follow-up turn would. The session row already exists
    // (handle_new_session minted it under this `thread_id`), so handle_prompt
    // resolves it by `session_id`.
    let initial_prompt_sent = match body.initial_prompt.as_deref().map(str::trim) {
        Some(prompt) if !prompt.is_empty() => {
            let engine: ClaudeCodeEngineState = Arc::clone(state.inner());
            let app_for_turn = app.clone();
            let tid = thread_id.clone();
            let text = prompt.to_string();
            tauri::async_runtime::spawn(async move {
                let req = PromptRequest::new(
                    SessionId::new(tid.clone()),
                    vec![ContentBlock::Text(TextContent::new(text))],
                );
                if let Err(e) = engine.handle_prompt(app_for_turn, req).await {
                    log::warn!(
                        "[iyke/session/start] initial_prompt turn for thread {tid} failed: {e}"
                    );
                }
            });
            true
        }
        _ => false,
    };

    Ok(Json(serde_json::json!({
        "ok": true,
        "thread_id": thread_id,
        "project_id": body.project_id,
        "cwd": cwd,
        "initial_prompt": body.initial_prompt,
        "initial_prompt_sent": initial_prompt_sent,
    })))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
