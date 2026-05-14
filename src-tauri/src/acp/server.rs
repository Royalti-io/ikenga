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
//! turn as it streams.
//!
//! Phase 6: `cancel` writes an `sdk_control_request { subtype: "interrupt"
//! }` envelope to claude's stdin instead of killing the child. Claude
//! stops mid-turn and emits its normal `Done` envelope, so the prompt
//! loop in `handle_prompt` exits naturally via its existing `Done` watch.
//! Transcript stays intact and the streaming child remains alive for the
//! next prompt. The legacy `cancel_streaming` (kill-the-child) path is
//! still used by the non-ACP `session_cancel` / `session_destroy` Tauri
//! commands for hard tear-down.
//!
//! Why this file deliberately hides the `agent-client-protocol` surface
//! from callers: spec churn touches the schema crate often, and we want a
//! single place to absorb that churn. Tauri command handlers + the future
//! engine pkg only touch methods on `AcpServer`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, LoadSessionResponse, McpCapabilities,
    NewSessionRequest, NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse,
    ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionId, SessionNotification, StopReason, ToolCallId, ToolCallUpdate, ToolCallUpdateFields,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{oneshot, Mutex as TokioMutex};

use crate::acp::fork::{validate_fork_request, ForkRequest, ForkResult};
use crate::acp::mode::{mode_state, AcpSessionMode};
use crate::acp::notify::{payload_from_permission, payload_from_system_hook};
use crate::acp::permission::{build_permission_options, outcome_to_response_body};
use crate::acp::{
    mapping::chat_event_to_session_updates,
    prompt::{extract_content, map_stop_reason},
};
use crate::commands::db::PaDb;
use crate::claude::event::ChatEvent;
use crate::claude::session::{
    send_control_response, send_interrupt, send_set_mode, send_user_message_with_content,
    SessionOpts, SessionsManager,
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
        // Phase 7: `image(true)` is now backed by real wire handling in
        // `handle_prompt` → `extract_content` → `build_user_envelope`.
        // Until Phase 1 we were advertising the capability optimistically.
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

    /// Handle ACP `session/new`. Registers an empty session with
    /// `SessionsManager`, returning the id back to the caller as the
    /// `SessionId`.
    ///
    /// Thread-id resolution: if `_meta.threadId` is present and non-empty,
    /// we honor it as the session id. This is an Ikenga extension so the
    /// frontend's stable UI thread id stays authoritative across UI
    /// remounts and `--resume` round-trips. The shell adapter always
    /// passes it; pure ACP peers that don't supply `_meta` get a fresh
    /// uuid v4 minted server-side.
    ///
    /// The Rust child is NOT spawned here — `claude::session` is lazy and
    /// the first `session/prompt` boots it. That matches the existing
    /// `session_ensure` semantics and avoids paying spawn cost on tabs the
    /// user opens but never types into.
    pub async fn handle_new_session(
        &self,
        app: AppHandle,
        req: NewSessionRequest,
    ) -> Result<NewSessionResponse, String> {
        let thread_id = resolve_thread_id(req.meta.as_ref());

        // Phase 3 (projects-first-class): every new session is attached to a
        // project. The frontend threads its active project id via
        // `_meta.projectId`; pure-ACP peers that omit it inherit the
        // shell's current active project. The project's `root_path`, when
        // set, overrides the ACP request's `cwd` so chats spawned from the
        // /sessions page or the engine adapter consistently land in the
        // project's working dir even if the caller forgot to thread it
        // through. Falls back to req.cwd, then $HOME.
        let pool = app
            .state::<std::sync::Arc<crate::commands::db::PaDb>>()
            .ensure_pool()
            .await
            .map_err(|e| e.to_string())?;
        let project_id = match resolve_project_id(req.meta.as_ref()) {
            Some(p) => p,
            None => crate::commands::projects::get_active_project_id(&pool).await?,
        };
        let project = crate::commands::projects::get_project(&pool, &project_id).await?;

        let req_cwd = req.cwd.to_string_lossy().into_owned();
        let cwd = project
            .as_ref()
            .and_then(|p| p.root_path.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                if req_cwd.is_empty() {
                    None
                } else {
                    Some(req_cwd.clone())
                }
            })
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        // Phase 3 ignores `mcp_servers` — claude already wires its own MCP
        // via `--mcp-config`. Phase 9 will translate ACP-declared servers
        // into a generated config file.
        let opts = SessionOpts::default();
        let initial_mode = opts.permission_mode;
        let session = self.sessions.get_or_create(&thread_id, &cwd, opts).await;

        // Phase 5 (projects-first-class): build the per-session overlay
        // dir from the layered 4-tier discovery (personal + workspace pkg
        // + project + project pkg) so the spawned claude child sees the
        // resolved skills/agents/commands and a merged `.mcp.json`. Best
        // effort — discovery or symlinking failures fall back to claude's
        // own discovery (skip the overlay rather than fail the session).
        let project_root = project
            .as_ref()
            .and_then(|p| p.root_path.clone())
            .filter(|s| !s.is_empty());
        match crate::claude::discovery::discover(&project_id, &pool, &app).await {
            Ok(tree) => {
                // Merge workspace + project-scoped pins; project pins win
                // on a tie so a project can override a workspace-wide choice.
                let workspace_pins = crate::claude::discovery::load_pins(&pool, "workspace")
                    .await
                    .unwrap_or_default();
                let project_pins = crate::claude::discovery::load_pins(
                    &pool,
                    &format!("project:{project_id}"),
                )
                .await
                .unwrap_or_default();
                let mut pins = workspace_pins;
                pins.extend(project_pins);
                match crate::claude::discovery::build_session_config_dir(
                    &app, &thread_id, &tree, &pins,
                ) {
                    Ok(dir) => {
                        session
                            .set_claude_spawn_overlay(
                                Some(dir.to_string_lossy().into_owned()),
                                project_root,
                            )
                            .await;
                    }
                    Err(e) => log::warn!(
                        "phase5: build_session_config_dir failed for thread {thread_id}: {e}",
                    ),
                }
            }
            Err(e) => log::warn!(
                "phase5: claude discovery failed for thread {thread_id} project {project_id}: {e}",
            ),
        }

        // Phase 5: advertise the four canonical session modes so the
        // frontend can render a picker, and surface our spawn-time mode
        // as `currentModeId`. Switching is handled by
        // `handle_set_mode` → `send_set_mode` / next-spawn flag.
        Ok(NewSessionResponse::new(SessionId::new(thread_id))
            .modes(mode_state(initial_mode)))
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

        // Phase 7: `extract_content` returns text + any image attachments.
        // The Phase 1 capability advertisement (`prompt_capabilities.image
        // = true`) is now backed by real wire handling here — image-bearing
        // prompts route through the array-content envelope builder.
        let content = extract_content(&req)?;

        // Subscribe BEFORE sending so we never miss a chunk emitted between
        // `send_user_message_with_content` returning and the receiver's
        // first `recv()`.
        let mut rx = session.events.subscribe();

        // Hand off to the existing streaming path. It may spawn the child
        // (first turn), or write to an existing stdin (follow-up turn).
        // `send_user_message_with_content` short-circuits to the legacy
        // text-only path when `content.images` is empty.
        send_user_message_with_content(app.clone(), session.clone(), content).await?;

        let channel = format!("acp://session/{thread_id}");
        let request_channel = format!("acp://session/{thread_id}/request");
        let stop_reason = loop {
            match rx.recv().await {
                Ok(ev) => {
                    if let ChatEvent::Done { stop_reason, .. } = &ev {
                        break map_stop_reason(stop_reason.as_deref());
                    }
                    // Phase 9: surface Notification / PermissionRequest
                    // hooks as `acp://notify` Tauri events. The frontend
                    // dispatcher (`acp-notify-bridge.ts`) decides whether
                    // to fire an OS notification + bump the sidebar
                    // badge based on window focus + active-pane state.
                    // PreToolUse / PostToolUse / SessionStart / Stop /
                    // etc. are filtered out inside `payload_from_system_hook`.
                    if let ChatEvent::SystemHook { content, .. } = &ev {
                        if let Some(hook_value) = content {
                            if let Some(notify) =
                                payload_from_system_hook(&thread_id, hook_value)
                            {
                                let _ = app.emit("acp://notify", &notify);
                            }
                        }
                        // Still fall through to the mapping layer below
                        // so the SessionUpdate (if any) still emits.
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

        // Phase 9: emit a parallel `acp://notify` so the OS-notification
        // bridge can decide whether to surface this approval-ask as an
        // OS notification + sidebar badge. The in-UI `PermissionDialog`
        // is the primary surface; this is the fallback when the user is
        // away from the focused thread (or has the app unfocused
        // entirely). Doing the focus-policy check on the frontend side
        // means the Rust core stays unaware of route / pane state.
        let notify = payload_from_permission(&thread_id, &tool_name, tool_input.as_ref());
        let _ = app.emit("acp://notify", &notify);

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


    /// Handle ACP `session/cancel`. Phase 6: write an interrupt
    /// control_request to claude's stdin instead of killing the child.
    /// Claude stops mid-turn and emits its normal `Done` envelope, so the
    /// prompt loop in `handle_prompt` exits naturally via its existing
    /// `Done` watch. Transcript stays intact and the streaming child
    /// remains alive for the next prompt — we don't pay re-spawn cost on
    /// every Stop click.
    ///
    /// `send_interrupt` short-circuits to Ok when there's no streaming
    /// child to interrupt, so an unknown / stale `threadId` is a no-op
    /// (matches the previous "best-effort cancel" semantics).
    ///
    /// The legacy `cancel_streaming` (hard-kill) path is still used by
    /// the non-ACP `session_cancel` / `session_destroy` Tauri commands
    /// in `commands/claude.rs`, which need the guarantee for tear-down
    /// and HMR hygiene.
    #[allow(non_snake_case)]
    pub async fn handle_cancel(&self, threadId: String) -> Result<(), String> {
        let Some(session) = self.sessions.get(&threadId).await else {
            return Ok(());
        };
        send_interrupt(session).await
    }

    /// Handle ACP `session/set_mode`. Updates the tracked current mode for
    /// the session and, if a streaming child is alive, writes a
    /// `set_permission_mode` control_request to its stdin so the change
    /// takes effect immediately. If no child is alive, the mode is just
    /// updated in memory and the next `spawn_streaming` picks it up via
    /// the `--permission-mode` CLI flag.
    ///
    /// Errors with a descriptive message for unknown mode ids or unknown
    /// thread ids — callers should surface these as toast/inline errors
    /// rather than failing silently.
    pub async fn handle_set_mode(
        &self,
        thread_id: String,
        mode_id: String,
    ) -> Result<(), String> {
        let mode = AcpSessionMode::from_acp_id(&mode_id)
            .ok_or_else(|| format!("unknown mode id: {mode_id}"))?;
        let session = self
            .sessions
            .get(&thread_id)
            .await
            .ok_or_else(|| format!("no session for thread {thread_id}"))?;
        // Update tracked mode + opts so the next (re-)spawn picks it up
        // via `--permission-mode`. Holding both locks separately is fine —
        // there's no ordering invariant between them; we just want the
        // session struct to reflect the new mode atomically from any
        // observer's POV.
        *session.current_mode.lock().await = mode;
        session.opts.lock().await.permission_mode = mode;
        // If a live child exists, push the runtime switch to it. The
        // `send_set_mode` helper short-circuits to Ok when no child is
        // alive (same condition we'd otherwise check here), so we could
        // call it unconditionally — but checking first keeps the intent
        // explicit and avoids a redundant lock acquire on the hot path
        // where set_mode races a pre-first-prompt session.
        if session.streaming.lock().await.is_some() {
            send_set_mode(session.clone(), mode).await?;
        }
        Ok(())
    }

    /// Handle ACP `session/fork`. Phase 8 minimum implementation: clone an
    /// existing session by recording a new `chat_threads` row whose
    /// `branched_from` points at the source thread. The new session's
    /// `SessionOpts.resume_session_id` is seeded with the source's
    /// `claude_session_id` so the first prompt on the forked thread spawns
    /// `claude --resume <source_session_id>` (Phase 8 contract — see
    /// `spawn_streaming` in `claude::session`).
    ///
    /// We deliberately do NOT copy the on-disk JSONL transcript byte-for-byte
    /// here — that'd diverge the source's history and break the source's
    /// resume. Letting both threads share the same claude session id at the
    /// resume level is enough for the "branch from here" UX (the user gets
    /// a separate Ikenga thread but continues the same claude conversation
    /// from where they branched). TODO(phase-10/11): copy the JSONL up to
    /// `up_to_turn` for true history divergence.
    ///
    /// Unknown `source_thread_id` becomes a clean error (the SELECT returns
    /// no rows and we surface "no source thread"). We never throw a SQL FK
    /// violation up to the frontend.
    pub async fn handle_fork_session(
        &self,
        db: &PaDb,
        req: ForkRequest,
    ) -> Result<ForkResult, String> {
        validate_fork_request(&req)?;
        let pool = db.ensure_pool().await?;
        let now_ms: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        // Confirm the source exists + capture its claude_session_id / cwd so
        // the fork can `--resume` against the same on-disk JSONL. Missing
        // rows surface as a typed error rather than an FK violation on the
        // INSERT below.
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT claude_session_id, project_dir FROM chat_threads WHERE id = ?",
        )
        .bind(&req.source_thread_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("fork lookup: {e}"))?;
        let (source_claude_sid, source_cwd) = row.ok_or_else(|| {
            format!("no source thread for id {}", req.source_thread_id)
        })?;

        let new_thread_id = uuid::Uuid::new_v4().to_string();
        let up_to_turn = req.up_to_turn.map(|v| v as i64);
        let title = req.label.clone();

        sqlx::query(
            "INSERT INTO chat_threads
                (id, adapter, title, cwd, project_dir, claude_session_id,
                 branched_from, branched_from_turn, created_at, updated_at)
             VALUES (?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&new_thread_id)
        .bind(&title)
        .bind(&source_cwd)
        .bind(&source_cwd)
        .bind(&source_claude_sid)
        .bind(&req.source_thread_id)
        .bind(up_to_turn)
        .bind(now_ms)
        .bind(now_ms)
        .execute(&pool)
        .await
        .map_err(|e| format!("fork insert: {e}"))?;

        // Pre-register the in-memory session so the first frontend
        // `acpPrompt` finds it. Seeding `resume_session_id` here is the
        // Phase 8 minimum: the next `spawn_streaming` call appends
        // `--resume <source_claude_sid>` and the user continues the same
        // claude conversation in a new Ikenga thread.
        if let Some(sid) = source_claude_sid {
            let cwd = source_cwd.unwrap_or_else(|| "/".to_string());
            let opts = SessionOpts {
                resume_session_id: Some(sid),
                ..SessionOpts::default()
            };
            let _ = self.sessions.get_or_create(&new_thread_id, &cwd, opts).await;
        }

        Ok(ForkResult {
            new_thread_id,
            source_thread_id: req.source_thread_id,
            branched_from_turn: req.up_to_turn,
        })
    }

    /// Handle ACP `session/load`. Phase 8: re-attach to an existing session
    /// by `thread_id` without paying the cold-spawn cost. We ensure the
    /// session is registered in `SessionsManager` (lazy-creates if missing)
    /// and return its current mode advertisement so the frontend's mode
    /// picker can hydrate immediately. The claude child is NOT spawned
    /// here — it stays lazy until the first new `acpPrompt`.
    ///
    /// The on-disk JSONL transcript is loaded frontend-side via the
    /// existing JSONL reader path (`claude_read_jsonl`); Phase 8's
    /// contribution is just signaling "this thread is loadable" + giving
    /// the picker enough to render without an extra round-trip.
    ///
    /// Unknown thread ids return an explicit error so the frontend can
    /// distinguish "not yet a session" from "session exists but no live
    /// child". The session-route hook silently swallows the former and
    /// only logs loud errors on real failures.
    pub async fn handle_load_session(
        &self,
        thread_id: String,
    ) -> Result<LoadSessionResponse, String> {
        let session = self
            .sessions
            .get(&thread_id)
            .await
            .ok_or_else(|| format!("no session for thread {thread_id}"))?;
        let current = *session.current_mode.lock().await;
        Ok(LoadSessionResponse::new().modes(mode_state(current)))
    }
}

/// Resolve the session id to register under, honoring `_meta.threadId` from
/// the new-session request when present. Pure function so it can be tested
/// without an `AppHandle`.
///
/// Ikenga's frontend adapter passes its stable UI thread id via
/// `_meta.threadId` so the same id round-trips through `session/prompt`,
/// `session/set_mode`, etc. Pure-ACP peers that don't supply `_meta` get a
/// uuid v4 minted server-side.
fn resolve_thread_id(meta: Option<&serde_json::Map<String, serde_json::Value>>) -> String {
    meta.and_then(|m| m.get("threadId"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}", uuid::Uuid::new_v4()))
}

/// Pull `_meta.projectId` off a new-session request. Mirrors
/// `resolve_thread_id` exactly so the projects-first-class extension
/// rides along the same `_meta` envelope without touching the schema crate.
/// Empty-string projectId is treated as "absent" so a callsite that always
/// includes the field but with no value transparently falls back to the
/// shell's active project.
fn resolve_project_id(meta: Option<&serde_json::Map<String, serde_json::Value>>) -> Option<String> {
    meta.and_then(|m| m.get("projectId"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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
    fn resolve_thread_id_honors_meta() {
        // Phase 10 smoke regression: the shell adapter passes its stable UI
        // thread id via `_meta.threadId`. If the server ignores it and mints
        // a fresh uuid, the next `session/prompt` (which uses the UI thread
        // id) misses the session table and errors "no session for thread".
        // Spotted live via iyke on /sessions/$id after the migration.
        let mut meta = serde_json::Map::new();
        meta.insert("threadId".into(), serde_json::Value::String("ui-thread-42".into()));
        assert_eq!(resolve_thread_id(Some(&meta)), "ui-thread-42");
    }

    #[test]
    fn resolve_thread_id_falls_back_to_uuid_when_no_meta() {
        // Pure-ACP clients that don't send `_meta` get a uuid v4.
        let id = resolve_thread_id(None);
        assert_eq!(id.len(), 36);
        assert!(id.contains('-'));
    }

    #[test]
    fn resolve_project_id_honors_meta() {
        // Phase 3 of projects-first-class: the frontend threads its active
        // project id through `_meta.projectId` so the new session picks up
        // the project's root_path as its cwd. Missing/empty falls back to
        // the shell's active project (verified at the integration layer).
        let mut meta = serde_json::Map::new();
        meta.insert(
            "projectId".into(),
            serde_json::Value::String("music-2026".into()),
        );
        assert_eq!(
            resolve_project_id(Some(&meta)),
            Some("music-2026".to_string())
        );
    }

    #[test]
    fn resolve_project_id_returns_none_for_empty_string() {
        // Treat "" as absent so a callsite that always emits the field
        // (with no value) falls through to the active-project lookup.
        let mut meta = serde_json::Map::new();
        meta.insert("projectId".into(), serde_json::Value::String("".into()));
        assert_eq!(resolve_project_id(Some(&meta)), None);
    }

    #[test]
    fn resolve_project_id_returns_none_when_absent() {
        // No `_meta` at all → fall through to the active project.
        assert_eq!(resolve_project_id(None), None);
        let meta = serde_json::Map::new();
        assert_eq!(resolve_project_id(Some(&meta)), None);
    }

    #[test]
    fn resolve_thread_id_falls_back_when_meta_thread_id_empty() {
        // Empty string is treated as "not provided" — clamps to a uuid.
        let mut meta = serde_json::Map::new();
        meta.insert("threadId".into(), serde_json::Value::String("".into()));
        let id = resolve_thread_id(Some(&meta));
        assert_eq!(id.len(), 36);
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

    #[tokio::test]
    async fn set_mode_with_no_streaming_child_updates_tracked_mode_and_returns_ok() {
        // Phase 5: the common case for `set_mode` is "user clicked Auto
        // before sending their first message". No streaming child exists
        // yet, so the implementation must update `current_mode` and
        // `opts.permission_mode` in memory and return Ok — the next
        // `spawn_streaming` will pick the new mode up via the
        // `--permission-mode` flag.
        let server = AcpServer::default();
        let session = server
            .sessions
            .get_or_create(
                "t_setmode",
                "/tmp",
                crate::claude::session::SessionOpts::default(),
            )
            .await;
        // Sanity: starting state is Default.
        assert_eq!(
            *session.current_mode.lock().await,
            AcpSessionMode::Default,
        );

        server
            .handle_set_mode("t_setmode".into(), "auto".into())
            .await
            .expect("set_mode ok");

        // Tracked mode + opts both updated; no streaming child spawned.
        assert_eq!(*session.current_mode.lock().await, AcpSessionMode::Auto);
        assert_eq!(
            session.opts.lock().await.permission_mode,
            AcpSessionMode::Auto,
        );
        assert!(session.streaming.lock().await.is_none());
    }

    #[tokio::test]
    async fn set_mode_rejects_unknown_mode_id() {
        let server = AcpServer::default();
        let _ = server
            .sessions
            .get_or_create(
                "t_bad",
                "/tmp",
                crate::claude::session::SessionOpts::default(),
            )
            .await;
        let err = server
            .handle_set_mode("t_bad".into(), "supercharged".into())
            .await
            .expect_err("unknown mode should error");
        assert!(err.contains("unknown mode id"));
    }

    #[tokio::test]
    async fn set_mode_rejects_unknown_thread_id() {
        let server = AcpServer::default();
        let err = server
            .handle_set_mode("never_registered".into(), "auto".into())
            .await
            .expect_err("unknown thread should error");
        assert!(err.contains("no session for thread"));
    }

    #[tokio::test]
    async fn handle_cancel_with_no_session_is_ok() {
        // Phase 6: stale Stop clicks (thread already destroyed, never
        // registered, etc.) must be no-ops. The frontend can fire
        // `acpCancel` without checking session state first.
        let server = AcpServer::default();
        server
            .handle_cancel("never_registered".into())
            .await
            .expect("unknown thread should be Ok");
    }

    #[tokio::test]
    async fn handle_cancel_with_no_streaming_child_returns_ok() {
        // Phase 6: a session that exists but has no live streaming child
        // (turn already over, never spawned) should be a no-op. The
        // interrupt envelope is only meaningful while claude is reading
        // stdin mid-turn — outside of that window there's nothing to do.
        let server = AcpServer::default();
        let session = server
            .sessions
            .get_or_create(
                "t_cancel_idle",
                "/tmp",
                crate::claude::session::SessionOpts::default(),
            )
            .await;
        assert!(session.streaming.lock().await.is_none());

        server
            .handle_cancel("t_cancel_idle".into())
            .await
            .expect("idle session cancel returns Ok");

        // No streaming child was created as a side effect.
        assert!(session.streaming.lock().await.is_none());
    }

    // NOTE: "interrupt actually writes to stdin" is intentionally not
    // unit-tested here — that path needs a live streaming child, which
    // requires spawning the real `claude` binary or an elaborate mock
    // around `tokio::process::Child` + `ChildStdin`. The building blocks
    // (`interrupt_envelope` shape + `send_interrupt` no-op semantics) are
    // covered by `crate::acp::interrupt::tests` and
    // `crate::claude::session::tests::send_interrupt_with_no_streaming_child_is_ok`.
    // Integrated coverage lives in the iyke smoke harness
    // (`runAcpInterruptSmokeTest`).

    #[tokio::test]
    async fn handle_load_session_returns_modes() {
        // Phase 8: `session/load` re-attaches to a session and returns the
        // current mode so the picker can hydrate. We pre-register the
        // session, set its mode to Auto, then assert load returns Auto.
        let server = AcpServer::default();
        let session = server
            .sessions
            .get_or_create(
                "t_load",
                "/tmp",
                crate::claude::session::SessionOpts::default(),
            )
            .await;
        *session.current_mode.lock().await = AcpSessionMode::Auto;

        let resp = server
            .handle_load_session("t_load".into())
            .await
            .expect("load ok");
        let modes = resp.modes.expect("modes present");
        assert_eq!(modes.current_mode_id.0.as_ref(), AcpSessionMode::Auto.as_acp_id());
        assert_eq!(modes.available_modes.len(), 4);
    }

    #[tokio::test]
    async fn handle_load_session_errors_for_unknown_thread() {
        // A load for a thread that never went through `acpNewSession` (and
        // wasn't forked into) must surface a typed error. The frontend
        // distinguishes this from real failures (it silently swallows
        // "no session for thread" but logs loud errors otherwise).
        let server = AcpServer::default();
        let err = server
            .handle_load_session("never_registered".into())
            .await
            .expect_err("unknown thread errors");
        assert!(err.contains("no session for thread"));
    }

    #[tokio::test]
    async fn handle_fork_session_validates_input() {
        // Validation is pure-function — exercised here without touching
        // SQLite. Empty source_thread_id must surface a typed error before
        // we touch the pool. (Real fork flow tests would require an
        // in-memory PaDb plus migration application; covered indirectly by
        // the smoke harness via the Tauri command.)
        let server = AcpServer::default();
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = PaDb::new(tmp.path().join("pa.db"));
        let err = server
            .handle_fork_session(
                &db,
                ForkRequest {
                    source_thread_id: String::new(),
                    up_to_turn: None,
                    label: None,
                },
            )
            .await
            .expect_err("empty source errors");
        assert!(err.contains("source_thread_id"));
    }

    // NOTE: `handle_new_session` takes an `AppHandle`, which can't be
    // constructed in a `#[cfg(test)]` context without enabling tauri's
    // `test` feature. The SessionModeState wiring is exercised by
    // `mode::tests::mode_state_uses_current_and_full_available_list`
    // (pure-function) + `mode::tests::available_modes_returns_four`.
    // Integration coverage of the full request happens via the iyke
    // smoke harness (`runAcpSmokeTest` in `src/lib/dev/acp-smoke.ts`),
    // which Phase 5 extends to assert on `response.modes`.
}
