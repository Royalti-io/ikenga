//! Session-as-object model. A `Session` is a chat thread identified by a
//! stable, frontend-minted `thread_id` (uuid). It owns:
//!
//!   * an optional streaming-input claude child (`claude --print
//!     --input-format stream-json --output-format stream-json --verbose`)
//!     for chat turns, and
//!   * an optional PTY (`claude --resume <claude_session_id>` or `bash`)
//!     for "open this conversation in a terminal" affordances.
//!
//! Both transports parse into the same `ChatEvent` stream and emit on the
//! single channel `session://{thread_id}`. The frontend never sees Claude's
//! internal session id except as metadata it can display.
//!
//! Why one object instead of the two parallel maps we had before:
//!   * removes the placeholder-id / real-id alias dance — `thread_id` is the
//!     same before and after `system:init` fires.
//!   * makes Chat | Terminal a property of one session, not two unrelated
//!     things sharing a key.
//!   * lets the route URL stay stable across the placeholder→real transition,
//!     so React doesn't remount and the in-memory event buffer survives.
//!
//! Events: every parsed event is emitted on `session://{thread_id}`. We also
//! mirror to `claude://session/{real_session_id}` once known, so legacy
//! listeners (e.g. live-sessions store keyed on Claude id) keep working until
//! they migrate.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex};

use crate::acp::mode::AcpSessionMode;
use crate::acp::prompt::PromptContent;
use crate::claude::{
    artifact_watcher::ArtifactWatcher, event::ChatEvent, stream_parser::StreamParser,
};

/// Options passed to `session_ensure` / `session_send`. Mirrors the subset of
/// claude CLI flags we expose; deliberately narrow.
///
/// Phase 5: `permission_mode` is now an `AcpSessionMode` (typed enum), used
/// both as the initial value for `--permission-mode` on spawn and as the
/// in-memory tracked mode threaded through to `send_set_mode` for runtime
/// switches. The legacy free-form `permissionMode` string from the
/// `session_ensure` Tauri command still deserializes via the enum's
/// camelCase Serde derive (`plan` / `default` / `auto` / `bypassPermissions`).
#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct SessionOpts {
    /// Resume an existing Claude session by its on-disk id. Maps to
    /// `--resume <id>` on spawn.
    #[serde(rename = "resumeSessionId")]
    pub resume_session_id: Option<String>,
    /// Initial permission mode passed via `--permission-mode` on spawn.
    /// Runtime changes happen via `acp::server::handle_set_mode` →
    /// `send_set_mode`.
    #[serde(rename = "permissionMode")]
    pub permission_mode: AcpSessionMode,
    pub model: Option<String>,
}

/// The live streaming child owned by a session, if one is currently spawned.
pub struct StreamingChild {
    /// Held so we can kill the child on cancel/destroy.
    child: Mutex<Child>,
    /// Held so `session_send` can write follow-up user envelopes.
    stdin: Mutex<ChildStdin>,
}

/// Per-session live state. One entry per chat thread the user has touched in
/// this run; created lazily on first `session_ensure` and cleared by
/// `session_destroy` or when the streaming child exits.
pub struct Session {
    pub thread_id: String,
    pub cwd: String,
    pub opts: Mutex<SessionOpts>,
    /// Set once the parser sees the first `system:init` event. Used to mirror
    /// events on `claude://session/{real_session_id}` and to look up the
    /// on-disk JSONL when the frontend reopens later.
    pub claude_session_id: Mutex<Option<String>>,
    /// Streaming child for chat turns. Absent until first `session_send` or
    /// an explicit prompt-on-ensure spawn. `pub(crate)` so the ACP server
    /// can short-circuit on "no live child" in `handle_set_mode` without
    /// going through a fresh helper method. The lock itself is held only
    /// for the read in that path — never held across an await on stdin.
    pub(crate) streaming: Mutex<Option<Arc<StreamingChild>>>,
    /// PTY id (from `PtyManager`) if the session has an attached terminal.
    pub pty_id: Mutex<Option<String>>,
    /// Broadcast channel for parsed `ChatEvent`s observed on this session.
    /// The existing reader task (in `spawn_streaming`) sends every event here
    /// in addition to the `app.emit("session://...")` call so in-process
    /// subscribers (e.g. the ACP `handle_prompt` end-of-turn waiter) can
    /// observe the stream without going through the Tauri event bus.
    /// Capacity is generous because a single prompt can fan out many text
    /// chunks; lagging subscribers will see `RecvError::Lagged` which
    /// `handle_prompt` treats as fatal for the turn.
    pub events: broadcast::Sender<ChatEvent>,
    /// Phase 5: tracked current session mode. Initialized from
    /// `opts.permission_mode`. Updated by `acp::server::handle_set_mode`,
    /// which also writes a `set_permission_mode` control_request to claude's
    /// stdin if a streaming child is live. If no child is live, the next
    /// `spawn_streaming` picks up the new mode via the `--permission-mode`
    /// flag — `send_user_message` snapshots this into `opts.permission_mode`
    /// before spawning.
    pub current_mode: Mutex<AcpSessionMode>,
    /// Phase 5: per-session CLAUDE_CONFIG_DIR. When set, `spawn_streaming`
    /// passes it to the child via env. The dir is built by
    /// `claude::discovery::build_session_config_dir` at `handle_new_session`
    /// time and contains symlinks to the resolved 4-tier skills / agents /
    /// commands / hooks plus a merged `.mcp.json`. Sessions created through
    /// non-ACP paths (legacy `commands/claude.rs`, fork, load) leave this
    /// `None` and spawn without an overlay.
    pub claude_config_dir: Mutex<Option<String>>,
    /// Phase 5: per-session CLAUDE_PROJECT_DIR — the project's `root_path`
    /// for the project this session is attached to. Used by claude skills
    /// + commands that reference `${CLAUDE_PROJECT_DIR}` even when cwd has
    /// been changed by an `--add-dir`.
    pub claude_project_dir: Mutex<Option<String>>,
}

impl Session {
    pub fn new(thread_id: String, cwd: String, opts: SessionOpts) -> Self {
        // 1024 outstanding events should comfortably absorb the burstiest
        // assistant turns; chosen empirically — `cargo bench` not warranted
        // until we see a real lag complaint.
        let (events, _) = broadcast::channel(1024);
        let initial_mode = opts.permission_mode;
        Self {
            thread_id,
            cwd,
            opts: Mutex::new(opts),
            claude_session_id: Mutex::new(None),
            streaming: Mutex::new(None),
            pty_id: Mutex::new(None),
            events,
            current_mode: Mutex::new(initial_mode),
            claude_config_dir: Mutex::new(None),
            claude_project_dir: Mutex::new(None),
        }
    }

    /// Phase 5: set the spawn-time overlay for this session. Called from
    /// `acp::server::handle_new_session` after resolving the project +
    /// running discovery, before the first `spawn_streaming`. Idempotent —
    /// re-calling overwrites, which is fine for the resume path (load /
    /// fork) once those wire it in too.
    pub async fn set_claude_spawn_overlay(
        &self,
        config_dir: Option<String>,
        project_dir: Option<String>,
    ) {
        *self.claude_config_dir.lock().await = config_dir;
        *self.claude_project_dir.lock().await = project_dir;
    }
}

/// Sessions are keyed by `thread_id`. Distinct from the legacy
/// `ClaudeManager.by_placeholder` map: there's no placeholder concept here,
/// because the id is minted by the frontend and stays stable.
#[derive(Default)]
pub struct SessionsManager {
    by_thread: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionsManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_create(
        &self,
        thread_id: &str,
        cwd: &str,
        opts: SessionOpts,
    ) -> Arc<Session> {
        let mut guard = self.by_thread.lock().await;
        if let Some(s) = guard.get(thread_id) {
            return s.clone();
        }
        let s = Arc::new(Session::new(thread_id.to_string(), cwd.to_string(), opts));
        guard.insert(thread_id.to_string(), s.clone());
        s
    }

    pub async fn get(&self, thread_id: &str) -> Option<Arc<Session>> {
        self.by_thread.lock().await.get(thread_id).cloned()
    }

    pub async fn remove(&self, thread_id: &str) -> Option<Arc<Session>> {
        self.by_thread.lock().await.remove(thread_id)
    }

    /// HMR / cold-start hygiene: kill every streaming child we know about.
    /// Called from `session_destroy_all` on window 'beforeunload' so dev
    /// reloads don't leave zombies. PTYs are owned by `PtyManager`; this only
    /// touches streaming children.
    pub async fn kill_all_streaming(&self) {
        let snapshot: Vec<Arc<Session>> = {
            let guard = self.by_thread.lock().await;
            guard.values().cloned().collect()
        };
        for s in snapshot {
            let mut child_slot = s.streaming.lock().await;
            if let Some(c) = child_slot.take() {
                let mut child = c.child.lock().await;
                let _ = child.start_kill();
            }
        }
    }
}

pub type SessionsState = Arc<SessionsManager>;

// ─── Spawn / send / cancel ────────────────────────────────────────────────

/// Build the line-delimited user envelope that streaming-input mode expects:
/// `{"type":"user","message":{"role":"user","content":"<text>"}}\n`.
fn user_envelope(text: &str) -> String {
    let value = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

/// Phase 7: build the line-delimited user envelope for a `PromptContent`.
///
/// When `content.images` is empty this returns the same string-content
/// shape as `user_envelope` so the heavily-exercised text path is byte-
/// identical to its Phase 3 form. Only image-bearing messages take the
/// array-content branch — that keeps wire traces simple, doesn't risk
/// regressing the text path, and matches what claude accepts on both
/// sides (it tolerates array-form for text-only too, but the string form
/// is what it ships in its own SDK).
///
/// Image source shape mirrors what the Anthropic API accepts in
/// stream-json mode:
///   `{"type":"image","source":{"type":"base64","media_type":"...","data":"..."}}`
pub fn build_user_envelope(content: &PromptContent) -> String {
    if content.images.is_empty() {
        return user_envelope(&content.text);
    }
    let mut blocks: Vec<serde_json::Value> = Vec::with_capacity(1 + content.images.len());
    if !content.text.is_empty() {
        blocks.push(serde_json::json!({
            "type": "text",
            "text": content.text,
        }));
    }
    for image in &content.images {
        blocks.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.mime_type,
                "data": image.base64_data,
            },
        }));
    }
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": blocks,
        },
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

/// Build the line-delimited tool_result envelope. The `output` may be a
/// plain string or a structured value — Anthropic accepts both, the latter
/// is how we ferry back e.g. AskUserQuestion answers without losing shape.
fn tool_result_envelope(tool_use_id: &str, output: &serde_json::Value, is_error: bool) -> String {
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": output,
                "is_error": is_error,
            }]
        }
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

/// Spawn a streaming-input claude child for this session. The first user
/// envelope is written before the reader task starts (claude buffers stdin
/// until it begins reading, so the order is fine).
pub async fn spawn_streaming(
    app: AppHandle,
    session: Arc<Session>,
    initial_prompt: Option<String>,
) -> Result<(), String> {
    let cwd = session.cwd.clone();
    let resolved_cwd = shellexpand::full(&cwd)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| cwd.clone());

    let opts = session.opts.lock().await.clone();
    let config_dir = session.claude_config_dir.lock().await.clone();
    let project_dir = session.claude_project_dir.lock().await.clone();

    let mut command = Command::new("claude");
    command
        // Phase 4: `--permission-prompt-tool stdio` opens the
        // `sdk_control_request` channel on stdout so tool approvals become
        // a real round-trip (see `acp::server::handle_prompt`).
        //
        // Phase 5: `--dangerously-skip-permissions` retired. Permission
        // behavior is now driven entirely by `--permission-mode` (initial
        // state) plus stdin `sdk_control_request { subtype:
        // "set_permission_mode" }` envelopes (runtime switches via
        // `send_set_mode` below). The four ACP modes map as:
        //   plan              → claude `plan`
        //   default           → claude `default`
        //   auto              → claude `acceptEdits`
        //   bypassPermissions → claude `bypassPermissions`
        // See `crate::acp::mode` for the canonical mapping.
        .arg("--permission-prompt-tool")
        .arg("stdio")
        .arg("--permission-mode")
        .arg(opts.permission_mode.as_claude_flag())
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
        .kill_on_drop(true);
    // Phase 5 (projects-first-class): redirect claude's user-config
    // discovery into the session-local overlay dir built by
    // `claude::discovery::build_session_config_dir`. The overlay contains
    // symlinks to the resolved 4-tier skills/agents/commands plus a merged
    // `.mcp.json` covering personal + workspace + project + project_pkg
    // MCPs with pin resolution applied. When the overlay has MCPs we add
    // `--mcp-config <path> --strict-mcp-config` so claude uses only the
    // merged set and skips its own personal+project discovery (which
    // would otherwise re-add the same servers and double-count them).
    // CLAUDE_PROJECT_DIR is set for `${CLAUDE_PROJECT_DIR}` references in
    // skills + commands that need the project root even when claude's own
    // cwd has been moved by `--add-dir`.
    if let Some(ref dir) = config_dir {
        command.env("CLAUDE_CONFIG_DIR", dir);
        let mcp_path = std::path::Path::new(dir).join(".mcp.json");
        if mcp_path.exists() {
            command
                .arg("--mcp-config")
                .arg(&mcp_path)
                .arg("--strict-mcp-config");
        }
    }
    if let Some(ref pd) = project_dir {
        command.env("CLAUDE_PROJECT_DIR", pd);
    }
    // Phase 8: forks seed `resume_session_id` with the SOURCE thread's
    // `claude_session_id` at fork time (see `acp::server::handle_fork_session`),
    // so the first prompt on a forked thread resumes against the source's
    // on-disk JSONL transcript. The user effectively continues the same
    // claude conversation in a separate Ikenga thread.
    if let Some(ref id) = opts.resume_session_id {
        command.arg("--resume").arg(id);
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

    if let Some(p) = initial_prompt {
        let envelope = user_envelope(&p);
        if let Err(e) = stdin.write_all(envelope.as_bytes()).await {
            return Err(format!("initial prompt write: {e}"));
        }
        let _ = stdin.flush().await;
    }

    let streaming = Arc::new(StreamingChild {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    *session.streaming.lock().await = Some(streaming);

    // Reader task: stdout → StreamParser → emit ChatEvents
    let parser = std::sync::Mutex::new(StreamParser::new());
    let watcher = std::sync::Mutex::new(ArtifactWatcher::new());
    let app_reader = app.clone();
    let session_reader = session.clone();
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
                    // Capture the real Claude session id once.
                    let real_id_now = events.iter().find_map(|e| match e {
                        ChatEvent::SessionInit { session_id, .. } if !session_id.is_empty() => {
                            Some(session_id.clone())
                        }
                        _ => None,
                    });
                    if let Some(real) = real_id_now {
                        let mut guard = session_reader.claude_session_id.lock().await;
                        if guard.is_none() {
                            *guard = Some(real.clone());
                        }
                    }
                    emit_events(&app_reader, &session_reader, &events).await;
                }
                Err(e) => {
                    log::debug!("streaming claude reader closed: {e}");
                    break;
                }
            }
        }
        // EOF → child exited. Drop the streaming handle so the next send
        // re-spawns with --resume.
        *session_reader.streaming.lock().await = None;
    });

    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("claude stderr: {line}");
            }
        });
    }

    Ok(())
}

/// Emit events on `session://{thread_id}` and (once known) mirror to
/// `claude://session/{real_session_id}` for legacy listeners. Also fans out
/// to the in-process broadcast channel so ACP subscribers (`handle_prompt`'s
/// end-of-turn waiter) observe the same stream.
async fn emit_events(app: &AppHandle, session: &Arc<Session>, events: &[ChatEvent]) {
    let thread_channel = format!("session://{}", session.thread_id);
    for e in events {
        let _ = app.emit(&thread_channel, e);
        // `send` only errors when there are zero active receivers — fine,
        // that's the common case when nobody is listening in-process.
        let _ = session.events.send(e.clone());
    }
    if let Some(real) = session.claude_session_id.lock().await.clone() {
        let mirror = format!("claude://session/{real}");
        for e in events {
            let _ = app.emit(&mirror, e);
        }
    }
}

/// Send a user message to a session's streaming child. Spawns one if absent
/// (recovery after claude crashed or HMR). Returns Ok on success or a
/// human-readable error.
pub async fn send_user_message(
    app: AppHandle,
    session: Arc<Session>,
    text: String,
) -> Result<(), String> {
    let needs_spawn = session.streaming.lock().await.is_none();
    if needs_spawn {
        // Resume the conversation if we know its Claude id.
        let resume_id = session.claude_session_id.lock().await.clone();
        if resume_id.is_some() {
            let mut o = session.opts.lock().await;
            if o.resume_session_id.is_none() {
                o.resume_session_id = resume_id;
            }
        }
        spawn_streaming(app, session.clone(), Some(text.clone())).await?;
        return Ok(());
    }
    let streaming = session
        .streaming
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "streaming child vanished".to_string())?;
    let envelope = user_envelope(&text);
    let mut stdin = streaming.stdin.lock().await;
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

/// Phase 7: variant of `send_user_message` that accepts a structured
/// `PromptContent` (text + optional images). Text-only payloads delegate
/// straight to `send_user_message` so the legacy hot path is unchanged.
/// Image-bearing payloads build an array-content stream-json envelope
/// (see `build_user_envelope`) and write it to the streaming child, with
/// the same spawn-on-first-turn semantics as `send_user_message`.
pub async fn send_user_message_with_content(
    app: AppHandle,
    session: Arc<Session>,
    content: PromptContent,
) -> Result<(), String> {
    if content.images.is_empty() {
        // No images → preserve the byte-for-byte wire shape the text path
        // has been emitting since Phase 3.
        return send_user_message(app, session, content.text).await;
    }

    let needs_spawn = session.streaming.lock().await.is_none();
    if needs_spawn {
        // First-turn spawn: `spawn_streaming` only knows how to wrap a
        // plain text string into a stream-json envelope. For images we
        // spawn without an initial prompt, then write the prebuilt
        // array-content envelope ourselves on the new stdin. The reader
        // task is already drained-by-then but claude buffers stdin
        // before it starts processing, so order on the write side is
        // what matters and it lines up the same way.
        let resume_id = session.claude_session_id.lock().await.clone();
        if resume_id.is_some() {
            let mut o = session.opts.lock().await;
            if o.resume_session_id.is_none() {
                o.resume_session_id = resume_id;
            }
        }
        spawn_streaming(app, session.clone(), None).await?;
    }

    let streaming = session
        .streaming
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "streaming child vanished".to_string())?;
    let envelope = build_user_envelope(&content);
    let mut stdin = streaming.stdin.lock().await;
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

/// Send a tool_result envelope to the session's streaming child. Used by
/// interactive tool renderers (e.g. AskUserQuestion) to ferry the user's
/// answer back into Claude's agent loop. Fails if the streaming child is
/// not alive — the caller should have made sure a turn is in flight (a
/// tool_use can only arrive while one is).
pub async fn send_tool_result(
    session: Arc<Session>,
    tool_use_id: String,
    output: serde_json::Value,
    is_error: bool,
) -> Result<(), String> {
    let streaming = session
        .streaming
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "no streaming child for tool_result".to_string())?;
    let envelope = tool_result_envelope(&tool_use_id, &output, is_error);
    let mut stdin = streaming.stdin.lock().await;
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

/// Build the line-delimited `sdk_control_response` envelope claude expects
/// in reply to a `sdk_control_request`. `response_body` should be the inner
/// object (`{"behavior":"allow","updatedInput":{...}}` or
/// `{"behavior":"deny","message":"..."}`); we splice in the `request_id` so
/// both sides agree on the correlation key.
///
/// Public for unit tests; the only caller is `send_control_response`.
pub fn control_response_envelope(
    request_id: &str,
    response_body: &serde_json::Value,
) -> String {
    let mut inner = match response_body {
        serde_json::Value::Object(m) => m.clone(),
        // Defensive: spec says callers pass an object. If they don't,
        // wrap so the envelope still parses on claude's end.
        other => {
            let mut m = serde_json::Map::new();
            m.insert("response".into(), other.clone());
            m
        }
    };
    inner.insert(
        "request_id".into(),
        serde_json::Value::String(request_id.to_string()),
    );
    let value = serde_json::json!({
        "type": "sdk_control_response",
        "response": serde_json::Value::Object(inner),
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

/// Phase 4: write a `sdk_control_response` to the streaming child's stdin
/// in reply to a `sdk_control_request` we observed on stdout. `response`
/// is the response body (sans `request_id`/`type` wrapper) — typically
/// `{"behavior":"allow", "updatedInput": {...}}` or
/// `{"behavior":"deny", "message": "..."}`.
///
/// Errors if no streaming child is alive — the caller should only invoke
/// this in the middle of a prompt turn (which is the only time claude
/// emits a control_request).
pub async fn send_control_response(
    session: Arc<Session>,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let streaming = session
        .streaming
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "no streaming child for control_response".to_string())?;
    let envelope = control_response_envelope(&request_id, &response);
    let mut stdin = streaming.stdin.lock().await;
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

/// Phase 5: write a `set_permission_mode` control_request to claude's
/// stdin so the running session picks up a mode switch without a re-spawn.
/// Claude does NOT reply to this kind of control_request (unlike
/// `permission` which expects a `sdk_control_response`), so we don't park
/// a waiter — fire and forget.
///
/// If there's no streaming child alive, returns Ok without doing anything:
/// the caller is expected to have already updated `session.current_mode`
/// + `session.opts.permission_mode`, and the next `spawn_streaming` will
/// pick up the new mode via the `--permission-mode` CLI flag.
pub async fn send_set_mode(
    session: Arc<Session>,
    mode: AcpSessionMode,
) -> Result<(), String> {
    let streaming = session.streaming.lock().await.as_ref().cloned();
    let Some(streaming) = streaming else {
        // No live child → the mode will be applied on the next spawn via
        // `--permission-mode`. This is the expected path for the very
        // first set_mode call before any prompt has spawned a child.
        return Ok(());
    };
    let request_id = format!("{}", uuid::Uuid::new_v4());
    let envelope = crate::acp::mode::set_mode_envelope(mode, &request_id);
    let mut stdin = streaming.stdin.lock().await;
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

/// Phase 6: write an interrupt control_request to claude's stdin. The
/// streaming child stops mid-turn and emits its normal `Done` envelope
/// (the prompt loop in `acp::server::handle_prompt` watches for it), so
/// the transcript stays intact and the child remains alive for the next
/// turn. Unlike `cancel_streaming`, we do NOT kill the process.
///
/// Claude does NOT reply with a `sdk_control_response` for interrupts
/// (unlike `permission` which expects one), so this is fire-and-forget —
/// no waiter parking required.
///
/// If there's no streaming child alive there's nothing to interrupt —
/// returns Ok (idempotent). The ACP `session/cancel` semantics are "best
/// effort"; callers that need a hard guarantee should fall back to
/// `cancel_streaming` themselves.
pub async fn send_interrupt(session: Arc<Session>) -> Result<(), String> {
    let streaming = {
        let guard = session.streaming.lock().await;
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return Ok(()),
        }
    };
    let request_id = format!("{}", uuid::Uuid::new_v4());
    let envelope = crate::acp::interrupt::interrupt_envelope(&request_id);
    let mut stdin = streaming.stdin.lock().await;
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

/// Kill the streaming child. Leaves the in-memory `Session` so subsequent
/// `session_send` can re-spawn with `--resume`. Returns Ok if there was no
/// child to kill (idempotent).
///
/// Phase 6: the ACP `session/cancel` path no longer routes through here —
/// it uses `send_interrupt` instead so the transcript stays intact. This
/// function survives because the legacy `session_cancel` /
/// `session_destroy` Tauri commands (in `commands/claude.rs`) still need
/// the hard-kill semantics for tear-down / HMR hygiene.
pub async fn cancel_streaming(session: Arc<Session>) -> Result<(), String> {
    let taken = session.streaming.lock().await.take();
    if let Some(c) = taken {
        let mut child = c.child.lock().await;
        let _ = child.start_kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn control_response_envelope_wraps_allow_body() {
        // Sanity-check the exact wire shape claude expects in reply to a
        // permission control_request. Trailing newline is part of the
        // contract — claude reads stdin line-by-line.
        let body = json!({
            "behavior": "allow",
            "updatedInput": { "answers": { "Which color?": "Red" } },
        });
        let env = control_response_envelope("req_42", &body);
        assert!(env.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["type"], json!("sdk_control_response"));
        assert_eq!(parsed["response"]["request_id"], json!("req_42"));
        assert_eq!(parsed["response"]["behavior"], json!("allow"));
        assert_eq!(
            parsed["response"]["updatedInput"]["answers"]["Which color?"],
            json!("Red"),
        );
    }

    #[test]
    fn control_response_envelope_wraps_deny_body() {
        let body = json!({"behavior": "deny", "message": "User declined"});
        let env = control_response_envelope("req_99", &body);
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["response"]["behavior"], json!("deny"));
        assert_eq!(parsed["response"]["message"], json!("User declined"));
        assert_eq!(parsed["response"]["request_id"], json!("req_99"));
    }

    #[tokio::test]
    async fn send_interrupt_with_no_streaming_child_is_ok() {
        // Phase 6: ACP `session/cancel` semantics are best-effort. If
        // there's no streaming child alive (turn already over, or it was
        // never spawned), the interrupt is a no-op — not an error. The
        // outer `handle_cancel` relies on this so stale Stop clicks
        // don't surface as toast errors.
        let session = Arc::new(Session::new(
            "thread_int_test".into(),
            "/tmp".into(),
            SessionOpts::default(),
        ));
        assert!(session.streaming.lock().await.is_none());
        send_interrupt(session.clone())
            .await
            .expect("no-op send_interrupt returns Ok");
        // Still no child afterwards — interrupt never spawns.
        assert!(session.streaming.lock().await.is_none());
    }

    #[tokio::test]
    async fn send_set_mode_with_no_streaming_child_is_ok() {
        // Phase 5: until the first prompt spawns a child, `set_mode`
        // should just update the in-memory tracked mode and let the next
        // spawn pick it up via `--permission-mode`. The I/O helper itself
        // must therefore be a no-op when no child exists.
        let session = Arc::new(Session::new(
            "thread_test".into(),
            "/tmp".into(),
            SessionOpts::default(),
        ));
        assert!(session.streaming.lock().await.is_none());
        send_set_mode(session.clone(), AcpSessionMode::Auto)
            .await
            .expect("no-op send_set_mode returns Ok");
        // Still no child afterwards.
        assert!(session.streaming.lock().await.is_none());
    }

    #[test]
    fn user_envelope_with_text_only_uses_string_content() {
        // Phase 7: text-only `PromptContent` must produce byte-identical
        // output to the Phase 3 string-content shape. This preserves the
        // wire trace for the legacy, heavily-exercised text path.
        let content = PromptContent {
            text: "hello".into(),
            images: Vec::new(),
        };
        let env = build_user_envelope(&content);
        assert!(env.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["type"], json!("user"));
        assert_eq!(parsed["message"]["role"], json!("user"));
        // Critically: content stays a STRING, not an array.
        assert_eq!(parsed["message"]["content"], json!("hello"));
    }

    #[test]
    fn user_envelope_with_image_has_array_content() {
        // Phase 7: any image attachment forces the array-content branch.
        // The shape mirrors Anthropic's stream-json image content block:
        // `{"type":"image","source":{"type":"base64","media_type":"...","data":"..."}}`.
        let content = PromptContent {
            text: "what's this?".into(),
            images: vec![crate::acp::prompt::PromptImage {
                mime_type: "image/png".into(),
                base64_data: "aGVsbG8=".into(),
            }],
        };
        let env = build_user_envelope(&content);
        assert!(env.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        let blocks = parsed["message"]["content"]
            .as_array()
            .expect("content is an array when images are present");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], json!("text"));
        assert_eq!(blocks[0]["text"], json!("what's this?"));
        assert_eq!(blocks[1]["type"], json!("image"));
        assert_eq!(blocks[1]["source"]["type"], json!("base64"));
        assert_eq!(blocks[1]["source"]["media_type"], json!("image/png"));
        assert_eq!(blocks[1]["source"]["data"], json!("aGVsbG8="));
    }

    #[test]
    fn user_envelope_with_image_only_omits_text_block() {
        // Edge case: caller built a PromptContent with empty text (e.g.
        // user dragged an image and hit send without typing anything,
        // and the extractor's default-prompt fallback was bypassed).
        // The envelope should not emit an empty text block; the array
        // should contain only the image.
        let content = PromptContent {
            text: String::new(),
            images: vec![crate::acp::prompt::PromptImage {
                mime_type: "image/jpeg".into(),
                base64_data: "aGVsbG8=".into(),
            }],
        };
        let env = build_user_envelope(&content);
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        let blocks = parsed["message"]["content"].as_array().expect("array");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], json!("image"));
    }

    #[test]
    fn session_opts_permission_mode_defaults_to_default() {
        // `Default` is the safest starting state — every tool goes
        // through the permission round-trip.
        let opts = SessionOpts::default();
        assert_eq!(opts.permission_mode, AcpSessionMode::Default);
    }

    #[test]
    fn session_opts_permission_mode_deserializes_camel_case() {
        // The frontend wire-format uses camelCase ACP ids; verify the
        // serde mapping survives a full round-trip.
        let opts: SessionOpts = serde_json::from_value(serde_json::json!({
            "permissionMode": "bypassPermissions"
        }))
        .expect("deserialize ok");
        assert_eq!(opts.permission_mode, AcpSessionMode::BypassPermissions);
    }
}
