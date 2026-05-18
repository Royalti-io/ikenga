//! Claude Code session integration.
//!
//! Chat threads keyed by a stable, frontend-minted `thread_id`. Each session
//! owns an optional streaming-input claude child (piped stdin/stdout — claude
//! rejects stream-json over a TTY). Events emit on `session://{thread_id}`.
//! The session machinery lives in `crate::claude::session`.
//!
//! "Open in terminal" affordances (session-detail, new-session dialog, claude
//! Run Command) spawn `bash -c "claude …; exec $SHELL -i"` directly via the
//! generic `pty_spawn` from `commands::pty` — no claude-specific PTY path is
//! kept on the Rust side anymore.
//!
//! Wires:
//!  - `session_ensure` / `session_send` / `session_tool_result` /
//!    `session_cancel` / `session_destroy` / `session_destroy_all` — chat
//!    lifecycle.
//!  - `claude_list_sessions` — scans `~/.claude/projects/**` and summarizes
//!    every `.jsonl` it finds.
//!  - `claude_read_jsonl` — reads a finished session log from disk into
//!    `ChatEvent`s for the chat-view replay path.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, State};

use crate::claude::{
    event::ChatEvent,
    is_session_jsonl,
    jsonl_reader::{read_jsonl, summarize, SessionSummary as JsonlSessionSummary},
    projects_root,
    session::{cancel_streaming, send_tool_result, send_user_message, SessionOpts, SessionsState},
};
use crate::commands::db::PaDb;

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ClaudeOpts {
    pub prompt: Option<String>,
    #[serde(rename = "resumeSessionId")]
    pub resume_session_id: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// PTY rows. Defaults to 24. Ignored by streaming-chat spawn (no PTY).
    pub rows: Option<u16>,
    /// PTY cols. Defaults to 100. Ignored by streaming-chat spawn.
    pub cols: Option<u16>,
}

#[derive(Serialize)]
pub struct SessionSummary {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "projectDir")]
    pub project_dir: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "lastMessageAt")]
    pub last_message_at: Option<String>,
    #[serde(rename = "messageCount")]
    pub message_count: u64,
    pub title: Option<String>,
    pub model: Option<String>,
}

impl From<JsonlSessionSummary> for SessionSummary {
    fn from(s: JsonlSessionSummary) -> Self {
        Self {
            session_id: s.session_id,
            project_dir: s.project_dir,
            started_at: s.started_at,
            last_message_at: s.last_message_at,
            message_count: s.message_count,
            title: s.title,
            model: s.model,
        }
    }
}

#[tauri::command]
pub async fn claude_list_sessions(
    #[allow(non_snake_case)] projectDir: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<SessionSummary>, String> {
    let root = projects_root().ok_or_else(|| "HOME unset".to_string())?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    // If a project dir is provided, restrict to its slug. Empty string is
    // treated as "all projects" so the frontend can pass cwd or "" without
    // branching.
    let slug_filter = projectDir
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|d| d.replace('/', "-"));

    // Two-phase scan to keep the list view snappy when ~/.claude/projects has
    // thousands of jsonl files (real numbers: ~9k+). Phase 1 only reads
    // directory entries + mtime metadata; phase 2 calls `summarize` (which
    // reads the file contents) on the top-N most recently modified.
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => return Err(format!("read projects root: {e}")),
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if let Some(ref slug) = slug_filter {
            if dir.file_name().and_then(|n| n.to_str()) != Some(slug.as_str()) {
                continue;
            }
        }
        let inner = match std::fs::read_dir(&dir) {
            Ok(i) => i,
            Err(_) => continue,
        };
        for file in inner.flatten() {
            let path = file.path();
            if !is_session_jsonl(&path) {
                continue;
            }
            let mtime = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            candidates.push((path, mtime));
        }
    }

    // Newest mtime first. mtime ≈ last_message_at because claude appends to
    // the jsonl on every envelope it writes.
    candidates.sort_by(|a, b| b.1.cmp(&a.1));

    let take = limit.unwrap_or(usize::MAX);
    let mut summaries: Vec<SessionSummary> = Vec::with_capacity(take.min(candidates.len()));
    for (path, _) in candidates.into_iter().take(take) {
        match summarize(&path) {
            Ok(Some(s)) => summaries.push(s.into()),
            Ok(None) => {}
            Err(e) => log::debug!("summarize {} failed: {e}", path.display()),
        }
    }

    // Re-sort by the actual `last_message_at` from the summaries — mtime is a
    // good predictor but the in-file timestamp is canonical.
    summaries.sort_by(|a, b| {
        let key_a = a
            .last_message_at
            .as_deref()
            .unwrap_or(a.started_at.as_str());
        let key_b = b
            .last_message_at
            .as_deref()
            .unwrap_or(b.started_at.as_str());
        key_b.cmp(key_a)
    });
    Ok(summaries)
}

#[tauri::command]
pub async fn claude_read_jsonl(
    #[allow(non_snake_case)] sessionId: String,
) -> Result<Vec<ChatEvent>, String> {
    let path = locate_jsonl_for_session(&sessionId)
        .ok_or_else(|| format!("session {sessionId} not found on disk"))?;
    read_jsonl(&path).map_err(|e| format!("read_jsonl: {e}"))
}

// ─── Session-as-object commands ──────────────────────────────────────────────
//
// `thread_id` is a stable, frontend-minted uuid that identifies a chat thread
// for its entire lifetime. Claude's session id and any PTY id are attributes
// of the `Session`. Events emit on `session://{thread_id}` (single channel).

/// Idempotently create / fetch a session. No process is spawned; the
/// streaming child is lazy and lifts on the first `session_send`. Use this
/// when the UI wants to register a thread (e.g. open an empty chat tab)
/// before any prompt has been typed.
#[tauri::command]
pub async fn session_ensure(
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
    cwd: String,
    opts: ClaudeOpts,
) -> Result<SessionHandle, String> {
    // Phase 5: translate the legacy free-form `permissionMode` string into
    // the typed `AcpSessionMode`. Unknown / missing values fall back to
    // `Default` (the safest mode); the legacy chat surface never sets
    // anything outside the canonical four, so this is a no-op in practice.
    let permission_mode = opts
        .permission_mode
        .as_deref()
        .and_then(crate::engines::claude_code::mode::AcpSessionMode::from_acp_id)
        .unwrap_or_default();
    let opts = SessionOpts {
        resume_session_id: opts.resume_session_id,
        permission_mode,
        model: opts.model,
        // ADR-011 phase 3: legacy session_ensure path does not yet take
        // effort from the frontend. The composer mutates this post-spawn
        // via `acp_set_effort` instead. Default `Off` matches claude's own.
        effort: Default::default(),
    };
    let session = sessions.get_or_create(&threadId, &cwd, opts).await;
    let claude_session_id = session.claude_session_id.lock().await.clone();
    Ok(SessionHandle {
        thread_id: threadId,
        claude_session_id,
    })
}

/// Send a user message to the thread's streaming child. If no streaming
/// child is live, one is spawned (with `--resume <claude_session_id>` when
/// we already know it, so the conversation continues). The initial prompt
/// is the first stdin envelope of the spawn — single round-trip, no race.
#[tauri::command]
pub async fn session_send(
    app: AppHandle,
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
    text: String,
) -> Result<(), String> {
    let session = sessions
        .get(&threadId)
        .await
        .ok_or_else(|| format!("no session for thread {threadId}"))?;
    send_user_message(app, session, text).await
}

/// Submit a tool result back to Claude — used by interactive tool
/// renderers like `AskUserQuestion` to ferry the user's answer into the
/// agent loop. `output` is a JSON value (Anthropic accepts plain strings
/// or structured payloads); set `isError: true` to signal failure.
#[tauri::command]
pub async fn session_tool_result(
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
    #[allow(non_snake_case)] toolUseId: String,
    output: serde_json::Value,
    #[allow(non_snake_case)] isError: Option<bool>,
) -> Result<(), String> {
    let session = sessions
        .get(&threadId)
        .await
        .ok_or_else(|| format!("no session for thread {threadId}"))?;
    send_tool_result(session, toolUseId, output, isError.unwrap_or(false)).await
}

/// Kill the streaming child but leave the in-memory session row so the next
/// `session_send` can re-spawn (with `--resume`). Idempotent.
#[tauri::command]
pub async fn session_cancel(
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<(), String> {
    let Some(session) = sessions.get(&threadId).await else {
        return Ok(());
    };
    cancel_streaming(session).await
}

/// Tear down the session entirely. Kills any streaming child + removes the
/// in-memory entry. PTYs are owned by `PtyManager` and must be killed via
/// `pty_kill` separately. Idempotent.
#[tauri::command]
pub async fn session_destroy(
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<(), String> {
    if let Some(session) = sessions.remove(&threadId).await {
        cancel_streaming(session).await?;
    }
    Ok(())
}

/// HMR / page-reload hygiene: kill every streaming child this app owns.
/// Called by the frontend on window 'beforeunload' so dev reloads don't
/// orphan claude processes. PTYs are handled by `PtyManager` separately.
#[tauri::command]
pub async fn session_destroy_all(sessions: State<'_, SessionsState>) -> Result<(), String> {
    sessions.kill_all_streaming().await;
    Ok(())
}

#[derive(Serialize)]
pub struct SessionHandle {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "claudeSessionId")]
    pub claude_session_id: Option<String>,
}

// ─── internals ────────────────────────────────────────────────────────────────

/// Given a session id, find its on-disk jsonl by scanning project slug dirs.
fn locate_jsonl_for_session(session_id: &str) -> Option<PathBuf> {
    let root = projects_root()?;
    let target = format!("{session_id}.jsonl");
    for slug_entry in std::fs::read_dir(&root).ok()?.flatten() {
        let slug_dir = slug_entry.path();
        let candidate = slug_dir.join(&target);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

// ─── Phase 3 (projects-first-class): project-scoped session listing ───────────
//
// The /sessions list filters by the active project by default. Mirrors the
// iyke bridge endpoint at /iyke/session/list so the in-app FE and the
// external mcp-iyke surface read from the same SQL.

const CHAT_THREADS_DEFAULT_LIMIT: i64 = 50;
const CHAT_THREADS_MAX_LIMIT: i64 = 200;

#[derive(Serialize)]
pub struct ChatThreadSummary {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub project_id: Option<String>,
    pub claude_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn chat_threads_list_by_project(
    db: State<'_, Arc<PaDb>>,
    #[allow(non_snake_case)] projectId: Option<String>,
    #[allow(non_snake_case)] includeAll: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<ChatThreadSummary>, String> {
    let pool = db.ensure_pool().await?;
    let lim = limit
        .unwrap_or(CHAT_THREADS_DEFAULT_LIMIT)
        .clamp(1, CHAT_THREADS_MAX_LIMIT);
    let include_all = includeAll.unwrap_or(false);

    let project_filter: Option<String> = if include_all {
        None
    } else if let Some(p) = projectId.filter(|s| !s.is_empty()) {
        Some(p)
    } else {
        Some(crate::commands::projects::get_active_project_id(&pool).await?)
    };

    let rows = match project_filter.as_deref() {
        Some(pid) => {
            sqlx::query(
                "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_threads
             WHERE project_id = ?
             ORDER BY updated_at DESC
             LIMIT ?",
            )
            .bind(pid)
            .bind(lim)
            .fetch_all(&pool)
            .await
        }
        None => {
            sqlx::query(
                "SELECT id, title, cwd, project_id, claude_session_id, created_at, updated_at
             FROM chat_threads
             ORDER BY updated_at DESC
             LIMIT ?",
            )
            .bind(lim)
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|e| format!("list chat_threads: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| ChatThreadSummary {
            id: r.get("id"),
            title: r.get("title"),
            cwd: r.get("cwd"),
            project_id: r.get("project_id"),
            claude_session_id: r.get("claude_session_id"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

/// Reattribute a chat thread to a different project. Metadata-only — the
/// in-memory `Session` and any live claude subprocess keep the cwd they
/// were spawned with; only `chat_threads.project_id` changes.
#[tauri::command]
pub async fn chat_thread_move(
    db: State<'_, Arc<PaDb>>,
    #[allow(non_snake_case)] threadId: String,
    #[allow(non_snake_case)] projectId: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let target = crate::commands::projects::get_project(&pool, &projectId)
        .await?
        .ok_or_else(|| format!("project not found: {projectId}"))?;
    if target.archived_at.is_some() {
        return Err(format!("project is archived: {projectId}"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let res = sqlx::query("UPDATE chat_threads SET project_id = ?, updated_at = ? WHERE id = ?")
        .bind(&projectId)
        .bind(now)
        .bind(&threadId)
        .execute(&pool)
        .await
        .map_err(|e| format!("move chat thread: {e}"))?;
    if res.rows_affected() == 0 {
        return Err(format!("thread not found: {threadId}"));
    }
    Ok(())
}
