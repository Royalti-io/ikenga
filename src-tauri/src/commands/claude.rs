//! Claude Code session integration.
//!
//! Two spawn paths, two transports:
//!  - **Session-as-object** (`session_ensure` / `session_send` /
//!    `session_cancel` / `session_destroy` / `session_attach_pty`) — chat
//!    threads keyed by a stable, frontend-minted `thread_id`. Each session
//!    owns an optional streaming-input claude child (piped stdin/stdout —
//!    claude rejects stream-json over a TTY) and an optional PTY (e.g.
//!    `claude --resume`). Events emit on `session://{thread_id}`. The full
//!    implementation lives in `crate::claude::session`.
//!  - **PTY one-shot / interactive** — `claude_spawn_session` runs `claude
//!    [-p <prompt>] [--resume <id>]` in a PTY. With `prompt` it's headless
//!    one-shot; without, it boots claude's interactive TUI. Used by the new-
//!    session dialog's "Open in terminal" branch.
//!
//! Wires:
//!  - `session_ensure` / `session_send` / `session_cancel` / `session_destroy`
//!    / `session_destroy_all` / `session_attach_pty` — chat lifecycle.
//!  - `claude_spawn_session` — PTY spawn (one-shot or interactive).
//!  - `claude_list_sessions` — scans `~/.claude/projects/**` and summarizes
//!    every `.jsonl` it finds.
//!  - `claude_read_jsonl` — reads a finished session log from disk into
//!    `ChatEvent`s for the chat-view replay path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::claude::{
    artifact_watcher::ArtifactWatcher,
    event::ChatEvent,
    is_session_jsonl,
    jsonl_reader::{read_jsonl, summarize, SessionSummary as JsonlSessionSummary},
    projects_root,
    session::{cancel_streaming, send_user_message, SessionOpts, SessionsState},
    stream_parser::StreamParser,
};
use crate::pty::{PtyManager, SpawnOpts};

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
pub struct ClaudeSpawnResult {
    /// Initially the placeholder we generated; replaced by the real
    /// `system:init.session_id` once it arrives via the parsed event stream.
    /// Frontend should treat this as opaque and prefer the `session_id` from
    /// the first `SessionInit` event for any persistence.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "ptyId")]
    pub pty_id: String,
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

/// Per-session live state. One entry per active spawn; cleared on PTY exit.
struct LiveSession {
    #[allow(dead_code)]
    pty_id: String,
    /// Set once the parser sees the first `system:init` event. Until then,
    /// frontend code should rely on the placeholder returned by
    /// `claude_spawn_session`.
    real_session_id: Option<String>,
}

#[derive(Default)]
pub struct ClaudeManager {
    /// PTY-backed sessions (one-shot `-p` and interactive TUI). Keyed by the
    /// placeholder id we hand back from `claude_spawn_session`. Once the real
    /// id arrives, `real_session_id` gets populated and the entry stays under
    /// the placeholder key (so frontend handles still resolve while events
    /// are also re-emitted under the real id).
    by_placeholder: Mutex<HashMap<String, LiveSession>>,
}

impl ClaudeManager {
    pub fn new() -> Self {
        Self::default()
    }
}

pub type ClaudeManagerState = Arc<ClaudeManager>;

#[tauri::command]
pub async fn claude_spawn_session(
    app: AppHandle,
    pty: State<'_, Arc<PtyManager>>,
    claude: State<'_, ClaudeManagerState>,
    cwd: String,
    opts: ClaudeOpts,
) -> Result<ClaudeSpawnResult, String> {
    spawn_session(
        app,
        pty.inner().clone(),
        claude.inner().clone(),
        cwd,
        opts,
        None,
    )
    .await
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
        let key_a = a.last_message_at.as_deref().unwrap_or(a.started_at.as_str());
        let key_b = b.last_message_at.as_deref().unwrap_or(b.started_at.as_str());
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
    let opts = SessionOpts {
        resume_session_id: opts.resume_session_id,
        permission_mode: opts.permission_mode,
        model: opts.model,
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
pub async fn session_destroy_all(
    sessions: State<'_, SessionsState>,
) -> Result<(), String> {
    sessions.kill_all_streaming().await;
    Ok(())
}

/// Attach a PTY to this session — typically `claude --resume
/// <claude_session_id>` so the user can "open this conversation in a
/// terminal." The PTY events do NOT feed back into the chat event stream;
/// the terminal view subscribes to them separately via the existing PTY
/// listener. Returns the new pty id.
#[tauri::command]
pub async fn session_attach_pty(
    app: AppHandle,
    pty: State<'_, Arc<PtyManager>>,
    sessions: State<'_, SessionsState>,
    #[allow(non_snake_case)] threadId: String,
    opts: ClaudeOpts,
) -> Result<String, String> {
    let session = sessions
        .get(&threadId)
        .await
        .ok_or_else(|| format!("no session for thread {threadId}"))?;
    let claude_session_id = session.claude_session_id.lock().await.clone();
    let resume = opts.resume_session_id.clone().or(claude_session_id);

    let mut cmd: Vec<String> = vec!["claude".into(), "--dangerously-skip-permissions".into()];
    if let Some(ref id) = resume {
        cmd.push("--resume".into());
        cmd.push(id.clone());
    }
    if let Some(ref pm) = opts.permission_mode {
        cmd.push("--permission-mode".into());
        cmd.push(pm.clone());
    }
    if let Some(ref m) = opts.model {
        cmd.push("--model".into());
        cmd.push(m.clone());
    }

    let spawn_opts = SpawnOpts {
        cwd: session.cwd.clone(),
        cmd,
        env: HashMap::new(),
        rows: opts.rows.unwrap_or(24),
        cols: opts.cols.unwrap_or(100),
    };
    let pty_id = pty
        .spawn(app, spawn_opts)
        .await
        .map_err(|e| format!("spawn claude pty: {e}"))?;
    *session.pty_id.lock().await = Some(pty_id.clone());
    Ok(pty_id)
}

#[derive(Serialize)]
pub struct SessionHandle {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "claudeSessionId")]
    pub claude_session_id: Option<String>,
}

// ─── internals ────────────────────────────────────────────────────────────────

async fn spawn_session(
    app: AppHandle,
    pty: Arc<PtyManager>,
    claude: ClaudeManagerState,
    cwd: String,
    opts: ClaudeOpts,
    explicit_session_id: Option<String>,
) -> Result<ClaudeSpawnResult, String> {
    // Placeholder id used to address the session before the real one arrives.
    let placeholder_id = explicit_session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{}", uuid::Uuid::new_v4()));

    // Two PTY modes here. Streaming-input mode does NOT use a PTY because
    // claude rejects stream-json over a TTY (verified: "Error: Input must be
    // provided either through stdin or as a prompt argument when using
    // --print"). Streaming chat lives in `spawn_streaming_chat` below; this
    // function only handles one-shot (`-p`) and interactive TUI.
    let one_shot = opts.prompt.is_some();
    let interactive = !one_shot;

    let mut cmd: Vec<String> = vec!["claude".into()];
    cmd.push("--dangerously-skip-permissions".into());
    if one_shot {
        cmd.push("--print".into());
        cmd.push("--output-format".into());
        cmd.push("stream-json".into());
        cmd.push("--verbose".into());
    }
    if let Some(ref id) = opts.resume_session_id {
        cmd.push("--resume".into());
        cmd.push(id.clone());
    }
    if let Some(ref pm) = opts.permission_mode {
        cmd.push("--permission-mode".into());
        cmd.push(pm.clone());
    }
    if let Some(ref m) = opts.model {
        cmd.push("--model".into());
        cmd.push(m.clone());
    }
    if one_shot {
        if let Some(ref p) = opts.prompt {
            cmd.push("-p".into());
            cmd.push(p.clone());
        }
    }

    let spawn_opts = SpawnOpts {
        cwd: cwd.clone(),
        cmd,
        env: HashMap::new(),
        rows: opts.rows.unwrap_or(24),
        cols: opts.cols.unwrap_or(100),
    };

    let pty_id = if interactive {
        pty.spawn(app.clone(), spawn_opts)
            .await
            .map_err(|e| format!("spawn claude: {e}"))?
    } else {
        let parser = Arc::new(std::sync::Mutex::new(StreamParser::new()));
        let watcher = Arc::new(std::sync::Mutex::new(ArtifactWatcher::new()));
        let claude_for_sub = claude.clone();
        let app_for_sub = app.clone();
        let placeholder_for_sub = placeholder_id.clone();

        let subscriber = Box::new(move |bytes: &[u8]| {
            let mut events = match parser.lock() {
                Ok(mut p) => p.feed(bytes),
                Err(_) => return,
            };
            let extras = match watcher.lock() {
                Ok(mut w) => w.observe(&events),
                Err(_) => Vec::new(),
            };
            events.extend(extras);
            if events.is_empty() {
                return;
            }
            let placeholder = placeholder_for_sub.clone();
            let app = app_for_sub.clone();
            let claude = claude_for_sub.clone();
            // Persist + emit on the tokio runtime; the reader thread itself is
            // sync so we hand off via spawn.
            tauri::async_runtime::spawn(async move {
                // First event of the run may carry the real session id — capture
                // it so frontend can re-key, and emit on both channels so any
                // listener can find us.
                let real_id_now = events.iter().find_map(|e| match e {
                    ChatEvent::SessionInit { session_id, .. } if !session_id.is_empty() => {
                        Some(session_id.clone())
                    }
                    _ => None,
                });
                if let Some(real) = real_id_now {
                    let mut guard = claude.by_placeholder.lock().await;
                    if let Some(entry) = guard.get_mut(&placeholder) {
                        if entry.real_session_id.is_none() {
                            entry.real_session_id = Some(real.clone());
                        }
                    }
                    drop(guard);
                    let real_event = format!("claude://session/{real}");
                    for e in &events {
                        let _ = app.emit(&real_event, e);
                    }
                }
                let placeholder_event = format!("claude://session/{placeholder}");
                for e in &events {
                    let _ = app.emit(&placeholder_event, e);
                }
            });
        });

        pty.spawn_with_subscriber(app.clone(), spawn_opts, subscriber)
            .await
            .map_err(|e| format!("spawn claude: {e}"))?
    };

    {
        let mut guard = claude.by_placeholder.lock().await;
        guard.insert(
            placeholder_id.clone(),
            LiveSession {
                pty_id: pty_id.clone(),
                real_session_id: explicit_session_id.clone(),
            },
        );
    }

    // Persist a thread row so chat-list views can find this session even
    // before we see the first event. The plugin pool is preferred; if it
    // hasn't initialized yet we silently skip — phase 5 hardens this.
    if let Some(db) = app.try_state::<Arc<crate::commands::db::PaDb>>() {
        let cwd_clone = cwd.clone();
        let placeholder = placeholder_id.clone();
        let pty_id_clone = pty_id.clone();
        let model = opts.model.clone();
        let resume_id = opts.resume_session_id.clone();
        let db = db.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = upsert_thread(
                &db,
                &placeholder,
                resume_id.as_deref(),
                &cwd_clone,
                &pty_id_clone,
                model.as_deref(),
            )
            .await
            {
                log::debug!("thread upsert: {e}");
            }
        });
    }

    Ok(ClaudeSpawnResult {
        session_id: placeholder_id,
        pty_id,
    })
}


async fn upsert_thread(
    db: &Arc<crate::commands::db::PaDb>,
    placeholder: &str,
    real_session_id: Option<&str>,
    cwd: &str,
    pty_id: &str,
    model: Option<&str>,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let now: i64 = now_ms();
    sqlx::query(
        "INSERT INTO chat_threads
            (id, adapter, claude_session_id, project_dir, pty_id, model, created_at, updated_at)
         VALUES (?, 'cli', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            claude_session_id = COALESCE(excluded.claude_session_id, chat_threads.claude_session_id),
            project_dir = excluded.project_dir,
            pty_id = excluded.pty_id,
            updated_at = excluded.updated_at",
    )
    .bind(placeholder)
    .bind(real_session_id)
    .bind(cwd)
    .bind(pty_id)
    .bind(model)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|e| format!("upsert thread: {e}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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

