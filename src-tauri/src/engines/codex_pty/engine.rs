//! `CodexPtyEngine` — the actual engine surface.
//!
//! Sessions are recorded lazily (`handle_new_session` doesn't spawn the
//! codex child — it just registers an entry in the in-memory map). The
//! first `handle_prompt` spawns the PTY through the existing
//! `crate::pty::PtyManager`, writes the user text + `\n` to stdin, and
//! then drains the `agent_message_chunk`s emitted by the parser as
//! `SessionNotification`s on the `chat://session/{thread_id}` Tauri event.
//!
//! The handler blocks until the parser sees an idle-prompt marker (or
//! the 60s wallclock budget expires), then returns `StopReason::EndTurn`.
//! That mirrors what the Claude engine does — the FE adapter draws no
//! distinction between "the model finished" and "we timed out waiting"
//! beyond the stop reason on the final response.
//!
//! No tool calls, no permissions, no thinking blocks. PTY-wrapping a TUI
//! gives no reliable extraction path. Once we have an ACP-native codex
//! adapter (`@zed-industries/codex-acp`) this whole module gets archived.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::{
    LoadSessionResponse, NewSessionResponse, PromptResponse, SessionId, SessionNotification,
    StopReason,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, Mutex};

use crate::engines::codex_pty::parser::{is_done_marker, parse_chunk};
use crate::pty::{ByteSubscriber, PtyManager, SpawnOpts};

/// Maximum wallclock we wait for an idle-prompt marker before giving up
/// and returning `StopReason::EndTurn`. Matches the "the model is wedged"
/// failure mode the Claude engine handles via its `Done` watch; codex has
/// no equivalent stream-json signal, so we lean on a timer instead.
const PROMPT_TIMEOUT_SECS: u64 = 60;

/// Capacity of the per-session byte broadcast channel. The reader thread
/// that the PtyManager owns shoves chunks in here; the prompt handler
/// drains. 256 is the same number `claude::session` uses for its event
/// bus — keeps us out of `RecvError::Lagged` territory for any reasonable
/// terminal output rate (codex tops out around a few KB/s of rendered text).
const BROADCAST_CAPACITY: usize = 256;

/// Default PTY dimensions for codex. Codex re-renders the whole frame on
/// every keystroke, so an over-tall pty wastes cycles; 24x100 is enough
/// to capture realistic prompts without slowing down ANSI re-layout. The
/// dimensions are local to the engine — the user never sees this PTY's
/// rendered output directly.
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 100;

/// One row in the engine's session table. Tracks the PTY id (None until
/// the first prompt spawns it) plus a `broadcast::Sender<Vec<u8>>` that
/// the PTY's byte subscriber feeds. Subscribing late is fine: the prompt
/// handler subscribes before writing, so any output triggered by the
/// write is observed.
struct CodexSession {
    cwd: String,
    pty_id: Option<String>,
    bytes: broadcast::Sender<Vec<u8>>,
}

impl CodexSession {
    fn new(cwd: String) -> Self {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            cwd,
            pty_id: None,
            bytes: tx,
        }
    }
}

pub struct CodexPtyEngine {
    pty: Arc<PtyManager>,
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<CodexSession>>>>>,
}

impl CodexPtyEngine {
    pub fn new(pty: Arc<PtyManager>) -> Self {
        Self {
            pty,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a session id with the engine. Idempotent — re-registering
    /// the same id updates the recorded cwd but doesn't touch the PTY.
    /// The codex child is NOT spawned here; that's deferred until the
    /// first `handle_prompt` so opening a thread the user never types
    /// into doesn't pay the launch cost.
    pub async fn handle_new_session(
        &self,
        thread_id: String,
        cwd: String,
    ) -> Result<NewSessionResponse, String> {
        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(thread_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(CodexSession::new(cwd))));
        Ok(NewSessionResponse::new(SessionId::new(thread_id)))
    }

    /// Spawn the PTY on first call, then write `text\n` to it and drain
    /// the parser's emissions until we see the idle-prompt marker (or
    /// time out at 60s).
    pub async fn handle_prompt(
        &self,
        app: AppHandle,
        thread_id: String,
        text: String,
    ) -> Result<PromptResponse, String> {
        let session_arc = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| format!("no codex session for thread {thread_id}"))?
        };

        // Subscribe BEFORE we write so we never miss bytes that arrive
        // between the write returning and us subscribing.
        let mut rx = {
            let s = session_arc.lock().await;
            s.bytes.subscribe()
        };

        // Ensure the PTY is alive. Done under the per-session lock so two
        // concurrent prompts on the same thread don't double-spawn.
        self.ensure_spawned(&app, &session_arc).await?;

        // Write the user text + newline to drive codex into "do work" mode.
        let pty_id = {
            let s = session_arc.lock().await;
            s.pty_id
                .clone()
                .ok_or_else(|| "PTY id missing after spawn".to_string())?
        };
        let mut payload = text.into_bytes();
        payload.push(b'\n');
        self.pty
            .write(&pty_id, &payload)
            .map_err(|e| format!("codex pty write failed: {e}"))?;

        // Drain output until we see the done marker or hit the deadline.
        let channel = format!("chat://session/{thread_id}");
        let deadline = Instant::now() + Duration::from_secs(PROMPT_TIMEOUT_SECS);
        // Skip the user-echo + any chrome carried in the first chunk by
        // requiring we see at least one non-echo line _then_ the marker.
        // (Codex sometimes leaves a stale `❯` at the head of the buffer
        // from the previous turn; if we returned on the first marker we'd
        // ship empty turns. Tracking `saw_content` guards against that.)
        let mut saw_content = false;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                log::warn!(
                    target: "ikenga::engines::codex_pty",
                    "codex prompt timed out after {PROMPT_TIMEOUT_SECS}s on thread {thread_id}",
                );
                break;
            }
            let chunk = match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(c)) => c,
                Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
                    log::warn!(
                        target: "ikenga::engines::codex_pty",
                        "codex prompt lagged {n} chunks on thread {thread_id}",
                    );
                    continue;
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    // PTY died.
                    break;
                }
                Err(_elapsed) => break,
            };

            // Done-marker check uses the same stripped-and-trimmed line
            // logic the parser uses internally, but at the chunk level so
            // we don't need to emit updates one-by-one to detect "turn over".
            let stripped = strip_ansi_escapes::strip(&chunk);
            let text = String::from_utf8_lossy(&stripped);
            let marker_seen = text.lines().any(is_done_marker);

            let updates = parse_chunk(&chunk);
            for upd in updates {
                saw_content = true;
                let notif = SessionNotification::new(SessionId::new(thread_id.clone()), upd);
                let _ = app.emit(&channel, &notif);
            }

            if marker_seen && saw_content {
                break;
            }
        }

        Ok(PromptResponse::new(StopReason::EndTurn))
    }

    /// Best-effort cancel. Codex doesn't have a clean interrupt envelope
    /// the way claude does — Ctrl-C (SIGINT) on the child is the canonical
    /// way to stop a runaway turn. We send `\x03` (ETX) over the PTY,
    /// which the PTY layer relays to the foreground process group.
    pub async fn handle_cancel(&self, thread_id: String) -> Result<(), String> {
        let Some(session_arc) = self.sessions.lock().await.get(&thread_id).cloned() else {
            return Ok(());
        };
        let pty_id = session_arc.lock().await.pty_id.clone();
        let Some(pty_id) = pty_id else {
            return Ok(());
        };
        // 0x03 = ETX (Ctrl-C). PTY relays this to the foreground PG, which
        // signals SIGINT to the codex process. Best-effort — if the PTY is
        // already dead the write errors out and we surface it.
        self.pty
            .write(&pty_id, b"\x03")
            .map_err(|e| format!("codex pty cancel write failed: {e}"))?;
        Ok(())
    }

    /// Minimal load-session: just confirm the thread is registered. We
    /// don't have any session-level modes / picker state to advertise
    /// (codex's models are picked at spawn-time by codex's own CLI flags,
    /// not exposed through this engine).
    pub async fn handle_load_session(
        &self,
        thread_id: String,
    ) -> Result<LoadSessionResponse, String> {
        let sessions = self.sessions.lock().await;
        if sessions.contains_key(&thread_id) {
            Ok(LoadSessionResponse::new())
        } else {
            Err(format!("no codex session for thread {thread_id}"))
        }
    }

    /// Spawn the underlying codex PTY for this session if it hasn't been
    /// already. The subscriber forwards every raw byte chunk into the
    /// session's broadcast bus so concurrent prompt handlers (only one at
    /// a time today, but the abstraction permits more) can each drain.
    async fn ensure_spawned(
        &self,
        app: &AppHandle,
        session_arc: &Arc<Mutex<CodexSession>>,
    ) -> Result<(), String> {
        let needs_spawn = {
            let s = session_arc.lock().await;
            s.pty_id.is_none()
        };
        if !needs_spawn {
            return Ok(());
        }

        let (cwd, tx) = {
            let s = session_arc.lock().await;
            (s.cwd.clone(), s.bytes.clone())
        };

        let subscriber: ByteSubscriber = Box::new(move |bytes: &[u8]| {
            // `broadcast::send` errors only if there are zero receivers,
            // which is the steady-state between turns. Drop silently —
            // the next prompt's subscription will catch the next chunk.
            let _ = tx.send(bytes.to_vec());
        });

        let opts = SpawnOpts {
            cwd,
            cmd: vec!["codex".to_string()],
            env: HashMap::new(),
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
        };

        let pty_id = self
            .pty
            .spawn_with_subscriber(app.clone(), opts, subscriber)
            .await
            .map_err(|e| format!("codex pty spawn failed: {e}"))?;

        {
            let mut s = session_arc.lock().await;
            s.pty_id = Some(pty_id);
        }
        Ok(())
    }
}

/// Tauri-friendly wrapper around the engine. The parallel agent's
/// `EngineHandle` refactor will wrap one of these in its enum variant.
pub type CodexPtyEngineState = Arc<CodexPtyEngine>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_session_is_idempotent() {
        // Re-registering the same thread id doesn't error and doesn't
        // wipe the session row. The CLI scaffolder relies on this when
        // a thread is re-opened across an app restart.
        let pty = Arc::new(PtyManager::new());
        let engine = CodexPtyEngine::new(pty);
        let resp1 = engine
            .handle_new_session("t1".into(), "/tmp".into())
            .await
            .expect("first new_session");
        let resp2 = engine
            .handle_new_session("t1".into(), "/tmp".into())
            .await
            .expect("second new_session");
        assert_eq!(resp1.session_id.0.as_ref(), "t1");
        assert_eq!(resp2.session_id.0.as_ref(), "t1");
        // Internal map still has exactly one entry.
        assert_eq!(engine.sessions.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn cancel_on_unknown_thread_is_ok() {
        // Stale Stop clicks (thread never registered, app cold-started
        // and lost in-memory state) must be no-ops. Mirrors the claude
        // engine's `handle_cancel` semantics.
        let pty = Arc::new(PtyManager::new());
        let engine = CodexPtyEngine::new(pty);
        engine
            .handle_cancel("never_registered".into())
            .await
            .expect("unknown thread cancel ok");
    }

    #[tokio::test]
    async fn cancel_with_no_pty_is_ok() {
        // Session exists but the PTY was never spawned (no prompts yet).
        // Cancel should silently no-op rather than complain about a
        // missing PTY id.
        let pty = Arc::new(PtyManager::new());
        let engine = CodexPtyEngine::new(pty);
        engine
            .handle_new_session("t_idle".into(), "/tmp".into())
            .await
            .expect("new_session ok");
        engine
            .handle_cancel("t_idle".into())
            .await
            .expect("idle cancel ok");
    }

    #[tokio::test]
    async fn load_session_for_known_thread_returns_ok() {
        let pty = Arc::new(PtyManager::new());
        let engine = CodexPtyEngine::new(pty);
        engine
            .handle_new_session("t_load".into(), "/tmp".into())
            .await
            .expect("new_session ok");
        let _resp = engine
            .handle_load_session("t_load".into())
            .await
            .expect("load ok");
    }

    #[tokio::test]
    async fn load_session_for_unknown_thread_errors() {
        let pty = Arc::new(PtyManager::new());
        let engine = CodexPtyEngine::new(pty);
        let err = engine
            .handle_load_session("nope".into())
            .await
            .expect_err("unknown thread errors");
        assert!(err.contains("no codex session for thread"));
    }
}
