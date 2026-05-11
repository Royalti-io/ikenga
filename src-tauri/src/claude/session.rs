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
use tokio::sync::Mutex;

use crate::claude::{
    artifact_watcher::ArtifactWatcher, event::ChatEvent, stream_parser::StreamParser,
};

/// Options passed to `session_ensure` / `session_send`. Mirrors the subset of
/// claude CLI flags we expose; deliberately narrow.
#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct SessionOpts {
    /// Resume an existing Claude session by its on-disk id. Maps to
    /// `--resume <id>` on spawn.
    #[serde(rename = "resumeSessionId")]
    pub resume_session_id: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
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
    /// an explicit prompt-on-ensure spawn.
    streaming: Mutex<Option<Arc<StreamingChild>>>,
    /// PTY id (from `PtyManager`) if the session has an attached terminal.
    pub pty_id: Mutex<Option<String>>,
}

impl Session {
    pub fn new(thread_id: String, cwd: String, opts: SessionOpts) -> Self {
        Self {
            thread_id,
            cwd,
            opts: Mutex::new(opts),
            claude_session_id: Mutex::new(None),
            streaming: Mutex::new(None),
            pty_id: Mutex::new(None),
        }
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
/// `claude://session/{real_session_id}` for legacy listeners.
async fn emit_events(app: &AppHandle, session: &Arc<Session>, events: &[ChatEvent]) {
    let thread_channel = format!("session://{}", session.thread_id);
    for e in events {
        let _ = app.emit(&thread_channel, e);
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

/// Kill the streaming child. Leaves the in-memory `Session` so subsequent
/// `session_send` can re-spawn with `--resume`. Returns Ok if there was no
/// child to kill (idempotent).
pub async fn cancel_streaming(session: Arc<Session>) -> Result<(), String> {
    let taken = session.streaming.lock().await.take();
    if let Some(c) = taken {
        let mut child = c.child.lock().await;
        let _ = child.start_kill();
    }
    Ok(())
}
