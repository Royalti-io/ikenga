//! ACP server.
//!
//! Phase 1: `initialize` handshake — advertises capabilities, returns a
//! negotiated protocol version, otherwise a no-op.
//!
//! Phase 3: `new_session`, `prompt`, and `cancel`. `new_session` mints a
//! fresh thread id and registers it with the existing
//! `claude::session::SessionsManager` so subsequent `session/prompt` calls
//! route through to a real `claude` child. `prompt` blocks the request
//! future until the stream's `Done` event arrives, while concurrently
//! emitting ACP `SessionUpdate` notifications on
//! `acp://session/{threadId}` so the frontend can render the assistant's
//! turn as it streams. `cancel` is wired to `cancel_streaming` for now;
//! Phase 6 will swap in the real interrupt-control-request path.
//!
//! Why this file deliberately hides the `agent-client-protocol` surface
//! from callers: spec churn touches the schema crate often, and we want a
//! single place to absorb that churn. Tauri command handlers + the future
//! engine pkg only touch methods on `AcpServer`.

use std::sync::Arc;

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, McpCapabilities, NewSessionRequest,
    NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse, ProtocolVersion,
    SessionId, SessionNotification, StopReason,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;

use crate::acp::{mapping::chat_event_to_session_updates, prompt::{extract_text, map_stop_reason}};
use crate::claude::event::ChatEvent;
use crate::claude::session::{
    cancel_streaming, send_user_message, SessionOpts, SessionsManager,
};

/// Top-level ACP server. Holds an `Arc` to the shared `SessionsManager` so
/// `handle_new_session` / `handle_prompt` can reach the same in-memory
/// session table the legacy `session_*` Tauri commands use. The two surfaces
/// coexist until Phase 11 retires the legacy path.
pub struct AcpServer {
    pub sessions: Arc<SessionsManager>,
}

impl Default for AcpServer {
    fn default() -> Self {
        Self::new(Arc::new(SessionsManager::new()))
    }
}

impl AcpServer {
    pub fn new(sessions: Arc<SessionsManager>) -> Self {
        Self { sessions }
    }

    /// Negotiated protocol version we'll advertise. Hard-coded for now —
    /// the crate exports it as `ProtocolVersion::V1` (numeric 1).
    pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V1;

    /// Handle the ACP `initialize` request. Spec contract: respond with
    /// the protocol version we agree to (clamped to min(client, server))
    /// plus our advertised capabilities.
    ///
    /// We advertise:
    ///   - image input in prompts (claude supports it in streaming-input mode)
    ///   - HTTP + SSE MCP server registration (claude --mcp-config + SDK API)
    ///   - load/resume/fork/close session capabilities (claude --resume + on-disk JSONL)
    ///
    /// We do NOT advertise an `auth_methods` flow — `claude` handles its own
    /// auth (the user runs `claude login` once, credentials live in
    /// `~/.claude/.credentials.json`, and we inherit it on spawn).
    pub fn handle_initialize(&self, req: InitializeRequest) -> InitializeResponse {
        // Clamp to whichever side knows less. The ProtocolVersion impl
        // does numeric comparison via its inner u16.
        let negotiated = std::cmp::min(req.protocol_version, Self::PROTOCOL_VERSION);

        // Schema structs are `#[non_exhaustive]` with fluent builders.
        let prompt_caps = PromptCapabilities::default()
            .image(true)
            .embedded_context(true)
            .audio(false);
        let mcp_caps = McpCapabilities::default().http(true).sse(true);
        let agent_caps = AgentCapabilities::default()
            .load_session(true)
            .prompt_capabilities(prompt_caps)
            .mcp_capabilities(mcp_caps);

        InitializeResponse::new(negotiated)
            .agent_capabilities(agent_caps)
            .auth_methods(Vec::new())
    }

    /// Handle ACP `session/new`. Mints a fresh thread id (uuid v4), registers
    /// the empty session with `SessionsManager` keyed on that id, and returns
    /// the id back to the caller as the `SessionId`.
    ///
    /// The Rust child is NOT spawned here — `claude::session` is lazy and
    /// the first `session/prompt` boots it. That matches the existing
    /// `session_ensure` semantics and avoids paying spawn cost on tabs the
    /// user opens but never types into.
    pub async fn handle_new_session(
        &self,
        _app: AppHandle,
        req: NewSessionRequest,
    ) -> Result<NewSessionResponse, String> {
        let thread_id = format!("{}", uuid::Uuid::new_v4());
        let cwd = req.cwd.to_string_lossy().into_owned();
        // Phase 3 ignores `mcp_servers` — claude already wires its own MCP
        // via `--mcp-config`. Phase 9 will translate ACP-declared servers
        // into a generated config file.
        let _ = self
            .sessions
            .get_or_create(&thread_id, &cwd, SessionOpts::default())
            .await;
        Ok(NewSessionResponse::new(SessionId::new(thread_id)))
    }

    /// Handle ACP `session/prompt`. Subscribes to the session's in-process
    /// event broadcast BEFORE writing to stdin so we don't miss any events
    /// the reader emits between `send_user_message` returning and the
    /// subscribe call. Emits `SessionUpdate`s as Tauri events on
    /// `acp://session/{threadId}`, returns when a `Done` event arrives.
    ///
    /// Stop-reason mapping is in `prompt::map_stop_reason`. If the reader
    /// closes without ever emitting `Done` (e.g. the claude child crashes)
    /// we return `EndTurn` rather than block forever — the frontend will
    /// see the truncated stream and can decide how to surface that.
    pub async fn handle_prompt(
        &self,
        app: AppHandle,
        req: PromptRequest,
    ) -> Result<PromptResponse, String> {
        let thread_id = req.session_id.0.to_string();
        let session = self
            .sessions
            .get(&thread_id)
            .await
            .ok_or_else(|| format!("no session for thread {thread_id}"))?;

        let text = extract_text(&req)?;

        // Subscribe BEFORE sending so we never miss a chunk emitted between
        // `send_user_message` returning and the receiver's first `recv()`.
        let mut rx = session.events.subscribe();

        // Hand off to the existing streaming path. It may spawn the child
        // (first turn), or write to an existing stdin (follow-up turn).
        send_user_message(app.clone(), session.clone(), text).await?;

        let channel = format!("acp://session/{thread_id}");
        let stop_reason = loop {
            match rx.recv().await {
                Ok(ev) => {
                    if let ChatEvent::Done { stop_reason, .. } = &ev {
                        break map_stop_reason(stop_reason.as_deref());
                    }
                    let updates = chat_event_to_session_updates(&ev);
                    for upd in updates {
                        // Wrap each update in a SessionNotification so the
                        // frontend receives the canonical ACP envelope on
                        // the wire (sessionId + update). This matches what
                        // a real ACP JSON-RPC peer would send.
                        let notif = SessionNotification::new(
                            SessionId::new(thread_id.clone()),
                            upd,
                        );
                        let _ = app.emit(&channel, &notif);
                    }
                }
                // Lag means we fell behind the broadcast capacity. Phase 3
                // treats this as fatal-for-the-turn; the frontend will see
                // a truncated stream and a synthetic EndTurn. Tune the
                // channel capacity in `Session::new` if this trips in
                // practice — there's a TODO there.
                Err(RecvError::Lagged(n)) => {
                    log::warn!(
                        target: "ikenga::acp::server",
                        "prompt lagged {n} events on thread {thread_id}"
                    );
                    break StopReason::EndTurn;
                }
                // All senders gone (reader task exited) — child died before
                // emitting `Done`. Synthesize EndTurn so the caller's
                // future resolves cleanly.
                Err(RecvError::Closed) => break StopReason::EndTurn,
            }
        };

        Ok(PromptResponse::new(stop_reason))
    }

    /// Handle ACP `session/cancel`. Today this just kills the streaming
    /// child via `cancel_streaming`; Phase 6 swaps in the real
    /// `control_request { subtype: "interrupt" }` path so transcripts
    /// stay intact.
    #[allow(non_snake_case)]
    pub async fn handle_cancel(&self, threadId: String) -> Result<(), String> {
        let Some(session) = self.sessions.get(&threadId).await else {
            return Ok(());
        };
        cancel_streaming(session).await
    }
}

/// Tauri-friendly wrapper around the server.
pub type AcpServerState = Arc<AcpServer>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_negotiated_version_and_capabilities() {
        let server = AcpServer::default();
        let req = InitializeRequest::new(ProtocolVersion::V1);
        let resp = server.handle_initialize(req);
        assert_eq!(resp.protocol_version, ProtocolVersion::V1);
        assert!(resp.agent_capabilities.prompt_capabilities.image);
        assert!(resp.agent_capabilities.prompt_capabilities.embedded_context);
        assert!(resp.agent_capabilities.mcp_capabilities.http);
        assert!(resp.agent_capabilities.mcp_capabilities.sse);
        assert!(resp.agent_capabilities.load_session);
        assert!(resp.auth_methods.is_empty());
    }

    #[test]
    fn initialize_clamps_protocol_version_downward() {
        // Client claims V1 (the only version today). Once V2 ships, this
        // test will need updating to assert downward clamping when the
        // client claims V2 and we still only do V1.
        let server = AcpServer::default();
        let req = InitializeRequest::new(ProtocolVersion::V1);
        let resp = server.handle_initialize(req);
        assert!(resp.protocol_version <= AcpServer::PROTOCOL_VERSION);
    }
}
