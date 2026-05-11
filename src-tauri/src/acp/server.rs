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

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, McpCapabilities, NewSessionRequest,
    NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionId,
    SessionNotification, StopReason, ToolCallId, ToolCallUpdate, ToolCallUpdateFields,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{oneshot, Mutex as TokioMutex};

use crate::acp::permission::{build_permission_options, outcome_to_response_body};
use crate::acp::{
    mapping::chat_event_to_session_updates,
    prompt::{extract_text, map_stop_reason},
};
use crate::claude::event::ChatEvent;
use crate::claude::session::{
    cancel_streaming, send_control_response, send_user_message, SessionOpts, SessionsManager,
};

/// How long we wait for the client to answer a `session/request_permission`
/// before giving up and synthesizing a cancellation. 5 minutes mirrors the
/// IDE-prompt patience window claude itself uses, but it's a safety net —
/// the expected path is a near-immediate response from the UI.
const PERMISSION_TIMEOUT_SECS: u64 = 300;

/// Top-level ACP server. Holds an `Arc` to the shared `SessionsManager` so
/// `handle_new_session` / `handle_prompt` can reach the same in-memory
/// session table the legacy `session_*` Tauri commands use. The two surfaces
/// coexist until Phase 11 retires the legacy path.
/// Shared map of parked permission round-trips. Producer (`handle_prompt`)
/// inserts on `ControlRequest`; consumer (`acp_respond_permission` via
/// `resolve_permission`) removes and fires. The background task that writes
/// the eventual `sdk_control_response` to claude's stdin also evicts on
/// timeout. `Arc<TokioMutex<...>>` so both the foreground server (`&self`)
/// and the spawned task can reach the same map without juggling lifetimes.
pub type PermissionWaiters =
    Arc<TokioMutex<HashMap<String, oneshot::Sender<RequestPermissionResponse>>>>;

pub struct AcpServer {
    pub sessions: Arc<SessionsManager>,
    /// Permission round-trip waiters keyed by `request_id`. See
    /// `PermissionWaiters` type alias for the lifecycle.
    permission_waiters: PermissionWaiters,
}

impl Default for AcpServer {
    fn default() -> Self {
        Self::new(Arc::new(SessionsManager::new()))
    }
}

impl AcpServer {
    pub fn new(sessions: Arc<SessionsManager>) -> Self {
        Self {
            sessions,
            permission_waiters: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    /// Called from the `acp_respond_permission` Tauri command. Removes the
    /// parked oneshot for `request_id` and fires it with the client's
    /// chosen outcome. Returns Ok even when the id is unknown (e.g. the
    /// turn was cancelled out from under us) so the frontend doesn't get a
    /// noisy error on stale UI replies.
    pub async fn resolve_permission(
        &self,
        request_id: String,
        response: RequestPermissionResponse,
    ) -> Result<(), String> {
        let mut guard = self.permission_waiters.lock().await;
        match guard.remove(&request_id) {
            Some(tx) => {
                // Receiver may have dropped (timeout / cancel race) — that's
                // fine. The control_response was already sent in that case.
                let _ = tx.send(response);
                Ok(())
            }
            None => {
                log::debug!(
                    target: "ikenga::acp::server",
                    "no waiter for permission request_id={request_id}; ignoring",
                );
                Ok(())
            }
        }
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
        let request_channel = format!("acp://session/{thread_id}/request");
        let stop_reason = loop {
            match rx.recv().await {
                Ok(ev) => {
                    if let ChatEvent::Done { stop_reason, .. } = &ev {
                        break map_stop_reason(stop_reason.as_deref());
                    }
                    // Phase 4: claude wants permission for a tool. Spin off
                    // the round-trip so the broadcast reader keeps draining
                    // while we wait on the client. We DO NOT block this
                    // loop on the oneshot — claude will continue streaming
                    // (assistant text, etc.) in the meantime.
                    if let ChatEvent::ControlRequest {
                        request_id,
                        subtype,
                        tool_name,
                        tool_input,
                    } = &ev
                    {
                        if subtype == "permission" {
                            self.spawn_permission_round_trip(
                                app.clone(),
                                session.clone(),
                                thread_id.clone(),
                                request_channel.clone(),
                                request_id.clone(),
                                tool_name.clone().unwrap_or_default(),
                                tool_input.clone(),
                            )
                            .await;
                        } else {
                            log::debug!(
                                target: "ikenga::acp::server",
                                "ignoring control_request subtype={subtype} on thread {thread_id} (phase 4 handles permission only)",
                            );
                        }
                        continue;
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

    /// Park a oneshot, emit the `session/request_permission` event, and
    /// spawn a task that awaits the client's reply (or times out) and then
    /// writes the corresponding `sdk_control_response` back to claude's
    /// stdin. The outer prompt loop must keep draining events while this
    /// is in flight — claude will emit assistant text in parallel with the
    /// permission round-trip, and blocking the loop would dead-end the
    /// transcript.
    async fn spawn_permission_round_trip(
        &self,
        app: AppHandle,
        session: Arc<crate::claude::session::Session>,
        thread_id: String,
        request_channel: String,
        request_id: String,
        tool_name: String,
        tool_input: Option<Value>,
    ) {
        // Park the receiver up-front so a fast client response can't slip
        // in before we register the waiter.
        let (tx, rx) = oneshot::channel::<RequestPermissionResponse>();
        let waiters = self.permission_waiters.clone();
        {
            let mut guard = waiters.lock().await;
            guard.insert(request_id.clone(), tx);
        }

        // Build the ACP `RequestPermissionRequest`. The `tool_call` field
        // is a `ToolCallUpdate` (NOT a full `ToolCall`) per the spec — we
        // populate raw_input + title so the UI has enough context to
        // render an informative dialog.
        let options = build_permission_options(&tool_name, tool_input.as_ref());
        let fields = ToolCallUpdateFields::new()
            .title(tool_name.clone())
            .raw_input(tool_input.clone());
        let tool_call_update = ToolCallUpdate::new(ToolCallId::new(request_id.clone()), fields);
        let req = RequestPermissionRequest::new(
            SessionId::new(thread_id.clone()),
            tool_call_update,
            options,
        );

        // Wire payload mirrors what an ACP peer would receive over JSON-RPC.
        let payload = serde_json::json!({
            "requestId": request_id,
            "request": req,
        });
        let _ = app.emit(&request_channel, &payload);

        // Move the heavy lifting onto its own task so the outer prompt
        // loop keeps draining claude's stdout.
        let waiters_handle = waiters.clone();
        let request_id_for_task = request_id.clone();
        let tool_name_for_task = tool_name;
        let tool_input_for_task = tool_input;
        let session_for_task = session.clone();
        tauri::async_runtime::spawn(async move {
            let response = match tokio::time::timeout(
                Duration::from_secs(PERMISSION_TIMEOUT_SECS),
                rx,
            )
            .await
            {
                Ok(Ok(resp)) => resp,
                Ok(Err(_)) | Err(_) => {
                    // Sender dropped (server torn down) OR timeout. Either
                    // way, synthesize a Cancelled outcome so claude doesn't
                    // hang waiting on us. We also evict the (possibly
                    // already-removed) waiter to keep the map tidy.
                    {
                        let mut guard = waiters_handle.lock().await;
                        guard.remove(&request_id_for_task);
                    }
                    RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
                }
            };
            let body = outcome_to_response_body(
                &tool_name_for_task,
                tool_input_for_task.as_ref(),
                &response,
            );
            if let Err(e) = send_control_response(session_for_task, request_id_for_task, body).await {
                log::warn!(
                    target: "ikenga::acp::server",
                    "send_control_response failed: {e}",
                );
            }
        });
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

    #[tokio::test]
    async fn resolve_permission_fires_parked_waiter() {
        // Insert a oneshot manually, then resolve via the public API and
        // confirm the receiver sees the response. Verifies the
        // HashMap<String, oneshot::Sender<...>> bridge is wired correctly
        // without spinning up a real claude child.
        let server = AcpServer::default();
        let (tx, rx) = oneshot::channel::<RequestPermissionResponse>();
        server
            .permission_waiters
            .lock()
            .await
            .insert("req_test".into(), tx);

        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            agent_client_protocol::schema::SelectedPermissionOutcome::new(
                crate::acp::permission::OPT_ALLOW_ONCE,
            ),
        ));
        server
            .resolve_permission("req_test".into(), resp)
            .await
            .expect("resolve_permission ok");

        let received = rx.await.expect("oneshot fires");
        match &received.outcome {
            RequestPermissionOutcome::Selected(s) => {
                assert_eq!(
                    s.option_id.0.as_ref(),
                    crate::acp::permission::OPT_ALLOW_ONCE,
                );
            }
            _ => panic!("expected Selected outcome"),
        }
    }

    #[tokio::test]
    async fn resolve_permission_for_unknown_id_is_ok() {
        // Stale UI replies (e.g. user clicked Approve on a request that
        // already timed out) must not error — they're just no-ops.
        let server = AcpServer::default();
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        server
            .resolve_permission("nonexistent".into(), resp)
            .await
            .expect("unknown id should be Ok");
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
