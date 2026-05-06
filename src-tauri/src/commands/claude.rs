//! Claude Code session integration.
//!
//! Two spawn paths, two transports:
//!  - **Streaming chat** — `claude_chat_spawn` runs `claude --print
//!    --input-format stream-json --output-format stream-json --verbose
//!    [--resume <id>]` over **piped stdin/stdout** (NOT a PTY — claude rejects
//!    stream-json input over a TTY). One long-lived process per chat thread;
//!    follow-up messages go via `claude_chat_send`. Anthropic-recommended
//!    pattern: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
//!  - **PTY one-shot / interactive** — `claude_spawn_session` runs `claude
//!    [-p <prompt>] [--resume <id>]` in a PTY. With `prompt` it's headless
//!    one-shot; without, it boots claude's interactive TUI. Used by the new-
//!    session dialog.
//!
//! Wires:
//!  - `claude_list_sessions` — scans `~/.claude/projects/**` and summarizes
//!    every `.jsonl` it finds.
//!  - `claude_spawn_session` — PTY spawn (one-shot or interactive).
//!  - `claude_chat_spawn` / `claude_chat_send` / `claude_chat_kill` — pipe-
//!    backed streaming child lifecycle.
//!  - `claude_read_jsonl` — reads a finished session log from disk into
//!    `ChatEvent`s for the chat-view escape hatch.

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

/// A long-lived, streaming-input claude child process. Distinct from
/// `LiveSession` (PTY-based, one-shot or interactive) because streaming-input
/// mode requires piped stdin — claude rejects stream-json over a TTY.
struct StreamingChild {
    /// Held so we can kill the child on cancel/destroy.
    child: tokio::sync::Mutex<tokio::process::Child>,
    /// Held so we can write user-message envelopes from `claude_chat_send`.
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    /// Set once the parser sees the first `system:init` event.
    real_session_id: tokio::sync::Mutex<Option<String>>,
}

#[derive(Default)]
pub struct ClaudeManager {
    /// PTY-backed sessions (one-shot `-p` and interactive TUI). Keyed by the
    /// placeholder id we hand back from `claude_spawn_session`. Once the real
    /// id arrives, `real_session_id` gets populated and the entry stays under
    /// the placeholder key (so frontend handles still resolve while events
    /// are also re-emitted under the real id).
    by_placeholder: Mutex<HashMap<String, LiveSession>>,
    /// Streaming-input children (one per chat thread). Keyed by placeholder
    /// id; lookups by real session id walk the values. Lives in a separate
    /// map from `by_placeholder` because the storage shape differs.
    streaming_children: Mutex<HashMap<String, Arc<StreamingChild>>>,
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

/// Spawn a long-lived claude child in streaming-input mode. Subsequent user
/// messages are sent via `claude_chat_send`. Returns a placeholder session id
/// (the real one arrives via the first `system:init` event on
/// `claude://session/{placeholder}` and `claude://session/{realId}`).
///
/// Recommended pattern per Anthropic docs:
/// https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
#[tauri::command]
pub async fn claude_chat_spawn(
    app: AppHandle,
    claude: State<'_, ClaudeManagerState>,
    cwd: String,
    opts: ClaudeOpts,
) -> Result<ClaudeSpawnResult, String> {
    spawn_streaming_chat(app, claude.inner().clone(), cwd, opts).await
}

/// Send a user message to a live streaming-input child by writing one JSON
/// envelope to its stdin. The session id may be either the placeholder
/// returned by `claude_chat_spawn` or the real session id reported by the
/// first `system:init` event. Returns an error if no live child matches.
#[tauri::command]
pub async fn claude_chat_send(
    claude: State<'_, ClaudeManagerState>,
    #[allow(non_snake_case)] sessionId: String,
    text: String,
) -> Result<(), String> {
    let child = find_streaming_child(claude.inner(), &sessionId)
        .await
        .ok_or_else(|| format!("no streaming session for {sessionId}"))?;
    let envelope = user_envelope(&text);
    let mut stdin = child.stdin.lock().await;
    use tokio::io::AsyncWriteExt;
    stdin
        .write_all(envelope.as_bytes())
        .await
        .map_err(|e| format!("stdin write: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("stdin flush: {e}"))?;
    Ok(())
}

/// Kill a streaming-input child. Idempotent — returns Ok if the session is
/// already gone.
#[tauri::command]
pub async fn claude_chat_kill(
    claude: State<'_, ClaudeManagerState>,
    #[allow(non_snake_case)] sessionId: String,
) -> Result<(), String> {
    let entry_key = {
        let guard = claude.streaming_children.lock().await;
        if guard.contains_key(&sessionId) {
            Some(sessionId.clone())
        } else {
            // Walk values to find by real_session_id.
            let mut hit = None;
            for (k, v) in guard.iter() {
                let real = v.real_session_id.lock().await;
                if real.as_deref() == Some(sessionId.as_str()) {
                    hit = Some(k.clone());
                    break;
                }
            }
            hit
        }
    };
    let Some(key) = entry_key else {
        return Ok(());
    };
    let removed = {
        let mut guard = claude.streaming_children.lock().await;
        guard.remove(&key)
    };
    if let Some(child) = removed {
        let mut c = child.child.lock().await;
        let _ = c.start_kill();
    }
    Ok(())
}

/// Build the line-delimited user envelope that streaming-input mode expects:
/// `{"type":"user","message":{"role":"user","content":"<text>"}}\n`. Uses
/// `serde_json` to escape the text correctly (newlines, quotes, etc.).
fn user_envelope(text: &str) -> String {
    let value = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

/// Look up a streaming child by placeholder id, falling back to real session id.
async fn find_streaming_child(
    claude: &ClaudeManagerState,
    session_id: &str,
) -> Option<Arc<StreamingChild>> {
    let guard = claude.streaming_children.lock().await;
    if let Some(c) = guard.get(session_id) {
        return Some(c.clone());
    }
    for c in guard.values() {
        let real = c.real_session_id.lock().await;
        if real.as_deref() == Some(session_id) {
            return Some(c.clone());
        }
    }
    None
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

/// Spawn a streaming-input claude child. Pipes stdin/stdout (no PTY — claude
/// rejects stream-json over a TTY). Wires the same `StreamParser` /
/// `ArtifactWatcher` pipeline as `spawn_session`, emitting parsed events on
/// `claude://session/{placeholder}` and (once known) `claude://session/{realId}`.
async fn spawn_streaming_chat(
    app: AppHandle,
    claude: ClaudeManagerState,
    cwd: String,
    opts: ClaudeOpts,
) -> Result<ClaudeSpawnResult, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    let placeholder_id = format!("pending-{}", uuid::Uuid::new_v4());
    let resolved_cwd = shellexpand::full(&cwd)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| cwd.clone());

    let mut command = Command::new("claude");
    command
        .arg("--dangerously-skip-permissions")
        .arg("--print")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(&resolved_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Don't leave behind orphaned children if the parent dies.
        .kill_on_drop(true);
    if let Some(ref id) = opts.resume_session_id {
        command.arg("--resume").arg(id);
    }
    if let Some(ref pm) = opts.permission_mode {
        command.arg("--permission-mode").arg(pm);
    }
    if let Some(ref m) = opts.model {
        command.arg("--model").arg(m);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn streaming claude: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin pipe missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe missing".to_string())?;
    let stderr = child.stderr.take();

    // Initial prompt as the first stdin envelope, before the reader task is
    // even up — claude buffers stdin until it's ready to read.
    if let Some(ref p) = opts.prompt {
        let envelope = user_envelope(p);
        if let Err(e) = stdin.write_all(envelope.as_bytes()).await {
            return Err(format!("initial prompt write: {e}"));
        }
        let _ = stdin.flush().await;
    }

    let real_session_id = tokio::sync::Mutex::new(None::<String>);
    let session = Arc::new(StreamingChild {
        child: tokio::sync::Mutex::new(child),
        stdin: tokio::sync::Mutex::new(stdin),
        real_session_id,
    });

    {
        let mut guard = claude.streaming_children.lock().await;
        guard.insert(placeholder_id.clone(), session.clone());
    }

    // ── Reader task: stdout → StreamParser → emit ChatEvents ────────────────
    let parser = std::sync::Mutex::new(StreamParser::new());
    let watcher = std::sync::Mutex::new(ArtifactWatcher::new());
    let app_for_reader = app.clone();
    let claude_for_reader = claude.clone();
    let placeholder_for_reader = placeholder_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = vec![0u8; 8 * 1024];
        loop {
            use tokio::io::AsyncReadExt;
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let mut events = match parser.lock() {
                        Ok(mut p) => p.feed(chunk),
                        Err(_) => break,
                    };
                    let extras = match watcher.lock() {
                        Ok(mut w) => w.observe(&events),
                        Err(_) => Vec::new(),
                    };
                    events.extend(extras);
                    if events.is_empty() {
                        continue;
                    }
                    let real_id_now = events.iter().find_map(|e| match e {
                        ChatEvent::SessionInit { session_id, .. } if !session_id.is_empty() => {
                            Some(session_id.clone())
                        }
                        _ => None,
                    });
                    if let Some(real) = real_id_now {
                        let mut g = session.real_session_id.lock().await;
                        if g.is_none() {
                            *g = Some(real.clone());
                        }
                        drop(g);
                        let real_event = format!("claude://session/{real}");
                        for e in &events {
                            let _ = app_for_reader.emit(&real_event, e);
                        }
                    }
                    let placeholder_event =
                        format!("claude://session/{placeholder_for_reader}");
                    for e in &events {
                        let _ = app_for_reader.emit(&placeholder_event, e);
                    }
                }
                Err(e) => {
                    log::debug!("streaming claude reader closed: {e}");
                    break;
                }
            }
        }
        // Stdout EOF → child has exited (or is about to). Drop from manager.
        let mut guard = claude_for_reader.streaming_children.lock().await;
        guard.remove(&placeholder_for_reader);
    });

    // ── Stderr drain: log it (but don't pollute the parser) ──────────────────
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("claude stderr: {line}");
            }
        });
    }

    // Persist a thread row so chat-list views can find this session.
    if let Some(db) = app.try_state::<Arc<crate::commands::db::PaDb>>() {
        let cwd_clone = resolved_cwd.clone();
        let placeholder = placeholder_id.clone();
        let model = opts.model.clone();
        let resume_id = opts.resume_session_id.clone();
        let db = db.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = upsert_thread(
                &db,
                &placeholder,
                resume_id.as_deref(),
                &cwd_clone,
                "",
                model.as_deref(),
            )
            .await
            {
                log::debug!("thread upsert (streaming): {e}");
            }
        });
    }

    Ok(ClaudeSpawnResult {
        session_id: placeholder_id,
        // Streaming children don't have a PTY id; frontend should ignore it
        // for streaming sessions and use sessionId for `claude_chat_send`.
        pty_id: String::new(),
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

