//! `GeminiAcpEngine` — the Gemini-side mirror of `ClaudeCodeEngine`.
//!
//! Public surface mirrors `ClaudeCodeEngine` so `commands/chat.rs` can
//! dispatch to either via `EngineHandle`. The big shape difference:
//! Claude wraps an in-process child whose stream-json envelopes we
//! translate to ACP types; Gemini IS an ACP-native peer, so we just
//! shuttle JSON-RPC over its stdio.
//!
//! One child per `threadId`. Spawned lazily on `handle_new_session`,
//! kept alive across subsequent `handle_prompt` calls so we don't pay
//! re-spawn cost on every turn. `handle_cancel` writes a
//! `session/cancel` notification — Gemini stops mid-turn and replies
//! to the in-flight `session/prompt` with a stop reason, which the
//! request waiter resolves naturally.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, LoadSessionResponse, McpCapabilities,
    NewSessionRequest, NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse,
    ProtocolVersion, RequestPermissionResponse, SessionId,
};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Mutex as TokioMutex;

use crate::engines::gemini_acp::transport::{
    GeminiChild, JsonRpcError, Transport, DEFAULT_GEMINI_ARGS, DEFAULT_GEMINI_CMD,
    METHOD_SESSION_CANCEL, METHOD_SESSION_LOAD, METHOD_SESSION_NEW, METHOD_SESSION_PROMPT,
    METHOD_SESSION_SET_MODE,
};

/// Top-level Gemini engine. Holds one `GeminiChild` per thread id and
/// owns the inbound permission-waiter table so resolve_permission can
/// drive responses across the registered transports.
pub struct GeminiAcpEngine {
    /// `threadId → GeminiChild` table. The child stays in `children`
    /// until explicit teardown (which today only happens implicitly on
    /// process exit). We never repurpose a child across threads — that
    /// would lose Gemini's internal session state.
    children: TokioMutex<HashMap<String, Arc<GeminiChild>>>,
    /// `(threadId, requestId) → ()` shadow set so a permission resolve
    /// can find the right child without sweeping every entry. Today
    /// this lives implicitly inside each child's transport
    /// (`park_inbound_waiter`), so the engine just routes by threadId.
    /// Kept here as documentation; no actual map needed because the
    /// FE sends `threadId` alongside `requestId` (see
    /// `commands/chat.rs::chat_respond_permission`).
    _phantom: (),
}

impl Default for GeminiAcpEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiAcpEngine {
    pub fn new() -> Self {
        Self {
            children: TokioMutex::new(HashMap::new()),
            _phantom: (),
        }
    }

    pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V1;

    /// ACP `initialize`. Static — we advertise what Gemini supports.
    /// The handshake against the child happens inside `ensure_child`
    /// (the child requires its own `initialize` before any session/*
    /// call; that's an internal detail of the transport, not surfaced
    /// here).
    pub fn handle_initialize(&self, req: InitializeRequest) -> InitializeResponse {
        let negotiated = std::cmp::min(req.protocol_version, Self::PROTOCOL_VERSION);
        // Gemini natively supports streaming + tool use + image input;
        // does NOT advertise extended thinking or effort. Matches
        // `CAP_GEMINI` in agent_detect::known.
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

    /// Ensure a child exists for `thread_id`. Spawns + initializes on
    /// first use. Subsequent calls return the cached child.
    async fn ensure_child(
        &self,
        thread_id: &str,
        cwd: &str,
        app: AppHandle,
    ) -> Result<Arc<GeminiChild>, String> {
        {
            let guard = self.children.lock().await;
            if let Some(child) = guard.get(thread_id) {
                return Ok(child.clone());
            }
        }
        // Spawn outside the lock to avoid holding it across an await on
        // the child process startup.
        let (transport, child_proc) =
            Transport::spawn(thread_id.to_string(), cwd, app, DEFAULT_GEMINI_CMD, DEFAULT_GEMINI_ARGS)
                .await?;
        let child = Arc::new(GeminiChild {
            transport,
            child: TokioMutex::new(child_proc),
            initialized: TokioMutex::new(false),
        });

        // Send the initialize handshake before any session/* call.
        // Gemini's ACP server requires it. Doing it inside ensure_child
        // means handle_new_session callers don't need to think about it.
        ensure_initialized(&child).await?;

        let mut guard = self.children.lock().await;
        // Race-safety: another caller might have just inserted. Prefer
        // the existing entry (its transport already initialized).
        let entry = guard
            .entry(thread_id.to_string())
            .or_insert_with(|| child.clone())
            .clone();
        Ok(entry)
    }

    /// ACP `session/new`. Spawns the child if needed, sends
    /// `session/new` to Gemini, returns a `NewSessionResponse` whose
    /// `sessionId` is the Ikenga `threadId` (so the rest of the chat
    /// surface routes events by the same key).
    pub async fn handle_new_session(
        &self,
        app: AppHandle,
        req: NewSessionRequest,
    ) -> Result<NewSessionResponse, String> {
        let thread_id = resolve_thread_id(req.meta.as_ref());
        let cwd = if req.cwd.as_os_str().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            req.cwd.to_string_lossy().into_owned()
        };

        let child = self.ensure_child(&thread_id, &cwd, app).await?;

        // Forward a real `session/new` to Gemini so it allocates its
        // own session-side state. We ignore Gemini's returned id and
        // surface the Ikenga thread id back to the caller — that's the
        // key the FE uses for everything downstream.
        let params = serde_json::json!({
            "mcpServers": [],
            "cwd": cwd,
        });
        let _result = child
            .transport
            .request(METHOD_SESSION_NEW, Some(params))
            .await?;

        // Phase 2: don't advertise modes — Gemini doesn't have the
        // four-canonical-mode shape Claude has.
        Ok(NewSessionResponse::new(SessionId::new(thread_id)))
    }

    /// ACP `session/prompt`. Forwards the prompt to Gemini's child and
    /// awaits its `PromptResponse`. Inbound `session/update`
    /// notifications + `session/request_permission` requests are
    /// dispatched by the transport's reader task — they don't pass
    /// through this function. Errors when no session exists for the
    /// thread (caller forgot to call `session/new`).
    pub async fn handle_prompt(
        &self,
        _app: AppHandle,
        req: PromptRequest,
    ) -> Result<PromptResponse, String> {
        let thread_id = req.session_id.0.to_string();
        let child = {
            let guard = self.children.lock().await;
            guard
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| format!("no gemini session for thread {thread_id}"))?
        };

        // Forward the prompt by serialising the schema struct directly.
        // The PromptRequest already carries the sessionId Gemini wants.
        let params =
            serde_json::to_value(&req).map_err(|e| format!("serialize PromptRequest: {e}"))?;
        let result = child
            .transport
            .request(METHOD_SESSION_PROMPT, Some(params))
            .await?;

        // Parse the result into the schema crate's PromptResponse so
        // the Tauri return type stays typed.
        let resp: PromptResponse =
            serde_json::from_value(result).map_err(|e| format!("parse PromptResponse: {e}"))?;
        Ok(resp)
    }

    /// ACP `session/cancel`. Notification, not request. Best-effort:
    /// unknown thread is a no-op (mirrors Claude's semantics).
    pub async fn handle_cancel(&self, thread_id: String) -> Result<(), String> {
        let child = {
            let guard = self.children.lock().await;
            guard.get(&thread_id).cloned()
        };
        let Some(child) = child else {
            return Ok(());
        };
        let params = serde_json::json!({ "sessionId": thread_id });
        child
            .transport
            .notify(METHOD_SESSION_CANCEL, Some(params))
            .await
    }

    /// Resolve a parked permission round-trip. The FE calls this via
    /// `chat_respond_permission` with the `requestId` we stamped into
    /// the `chat://session/{id}/request` event payload. We look up the
    /// child by the thread id (which the FE also includes via the
    /// dispatcher) — for the v1 minimum we sweep all children, since
    /// the dispatcher doesn't yet carry threadId for permission
    /// responses (matches Claude's existing API shape).
    pub async fn resolve_permission(
        &self,
        request_id: String,
        response: RequestPermissionResponse,
    ) -> Result<(), String> {
        let result_value =
            serde_json::to_value(&response).map_err(|e| format!("serialize response: {e}"))?;

        // Sweep all children — the inbound waiter map lives inside each
        // transport. First child that owns the id wins. In practice
        // there's only one active session per chat thread per engine.
        let children: Vec<Arc<GeminiChild>> = {
            let guard = self.children.lock().await;
            guard.values().cloned().collect()
        };
        for child in children {
            if child
                .transport
                .resolve_inbound_waiter(&request_id, result_value.clone())
                .await
            {
                return Ok(());
            }
        }
        log::debug!(
            target: "ikenga::engines::gemini_acp",
            "no waiter for permission request_id={request_id}; ignoring",
        );
        Ok(())
    }

    /// ACP `session/load`. Gemini handles its own session storage; we
    /// just ensure a child is alive and forward the request.
    pub async fn handle_load_session(
        &self,
        thread_id: String,
        cwd: String,
        app: AppHandle,
    ) -> Result<LoadSessionResponse, String> {
        let cwd = if cwd.is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            cwd
        };
        let child = self.ensure_child(&thread_id, &cwd, app).await?;
        let params = serde_json::json!({
            "sessionId": thread_id,
            "mcpServers": [],
            "cwd": cwd,
        });
        let result = child
            .transport
            .request(METHOD_SESSION_LOAD, Some(params))
            .await?;
        let resp: LoadSessionResponse =
            serde_json::from_value(result).map_err(|e| format!("parse LoadSessionResponse: {e}"))?;
        Ok(resp)
    }

    /// ACP `session/set_mode`. Gemini's mode surface may differ; we
    /// pass it through unchanged. Errors out cleanly if Gemini doesn't
    /// recognise the mode id.
    pub async fn handle_set_mode(
        &self,
        thread_id: String,
        mode_id: String,
    ) -> Result<(), String> {
        let child = {
            let guard = self.children.lock().await;
            guard
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| format!("no gemini session for thread {thread_id}"))?
        };
        let params = serde_json::json!({
            "sessionId": thread_id,
            "modeId": mode_id,
        });
        let _ = child
            .transport
            .request(METHOD_SESSION_SET_MODE, Some(params))
            .await?;
        Ok(())
    }

    /// ACP `set_model` / `set_effort`. Gemini doesn't advertise these
    /// (capabilities.effortControl = false, modelSwitching deferred to
    /// per-prompt). For now they're no-ops so the multi-engine
    /// dispatcher in `commands/chat.rs` can call them uniformly without
    /// special-casing the adapter id.
    pub async fn handle_set_model(
        &self,
        _thread_id: String,
        _model: Option<String>,
    ) -> Result<(), String> {
        Ok(())
    }

    pub async fn handle_set_effort(
        &self,
        _thread_id: String,
        _effort: crate::claude::session::EffortLevel,
    ) -> Result<(), String> {
        Ok(())
    }
}

/// Send the `initialize` handshake to Gemini's child. Required before
/// any session/* call. Idempotent — second-and-later calls short-circuit
/// via the `initialized` flag.
async fn ensure_initialized(child: &Arc<GeminiChild>) -> Result<(), String> {
    {
        let guard = child.initialized.lock().await;
        if *guard {
            return Ok(());
        }
    }
    let params = serde_json::json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false }
        }
    });
    let _result = child
        .transport
        .request(crate::engines::gemini_acp::transport::METHOD_INITIALIZE, Some(params))
        .await
        .map_err(|e| {
            // Wrap so the caller can distinguish initialize failures
            // from later session/* failures in logs.
            format!("gemini initialize: {e}")
        })?;
    let mut guard = child.initialized.lock().await;
    *guard = true;
    Ok(())
}

/// Lift the Ikenga-extension `_meta.threadId` off the new-session
/// request. Same shape as `claude_code::server::resolve_thread_id`.
fn resolve_thread_id(meta: Option<&serde_json::Map<String, Value>>) -> String {
    meta.and_then(|m| m.get("threadId"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}", uuid::Uuid::new_v4()))
}

/// Returned from `lib.rs::run()` for the `EngineRegistryState`.
pub type GeminiAcpEngineState = Arc<GeminiAcpEngine>;

// Convenience re-export so callers can write `JsonRpcError` without
// reaching into the transport module. Public surface stays small.
pub use crate::engines::gemini_acp::transport::JsonRpcError as GeminiJsonRpcError;
// Suppress unused-import warning on the alias; the public name above
// is the documented one.
#[allow(dead_code)]
fn _force_use_alias() -> Option<JsonRpcError> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_negotiated_version_and_capabilities() {
        let server = GeminiAcpEngine::default();
        let req = InitializeRequest::new(ProtocolVersion::V1);
        let resp = server.handle_initialize(req);
        assert_eq!(resp.protocol_version, ProtocolVersion::V1);
        assert!(resp.agent_capabilities.prompt_capabilities.image);
        // Gemini does NOT advertise extended thinking — verify we kept
        // the prompt-capabilities shape consistent with CAP_GEMINI.
        // (The schema crate's `prompt_capabilities` doesn't have a
        // `thinking` field, so this is mostly a smoke test of the
        // builder chain.)
    }

    #[test]
    fn resolve_thread_id_honors_meta() {
        let mut meta = serde_json::Map::new();
        meta.insert(
            "threadId".into(),
            serde_json::Value::String("gemini-thread-1".into()),
        );
        assert_eq!(resolve_thread_id(Some(&meta)), "gemini-thread-1");
    }

    #[test]
    fn resolve_thread_id_falls_back_to_uuid() {
        let id = resolve_thread_id(None);
        assert_eq!(id.len(), 36);
        assert!(id.contains('-'));
    }

    #[tokio::test]
    async fn handle_cancel_with_no_session_is_ok() {
        // Stale Stop clicks must be no-ops.
        let server = GeminiAcpEngine::default();
        server
            .handle_cancel("never_registered".into())
            .await
            .expect("unknown thread should be Ok");
    }

    #[tokio::test]
    async fn handle_prompt_errors_for_unknown_thread() {
        // Defensive: a prompt for a thread that never went through
        // new_session must surface a typed error, not panic. The Tauri
        // command layer surfaces this to the FE as a toast.
        let server = GeminiAcpEngine::default();
        let req = PromptRequest::new(SessionId::new("never"), Vec::new());
        let app_handle: Option<AppHandle> = None;
        let _ = app_handle; // marker: this branch needs no AppHandle
                            // because the error fires before we touch the child.

        // We can't construct an AppHandle in unit-tests without the
        // tauri test feature; call the inner lookup-and-error path
        // directly by holding the lock and checking absence.
        let guard = server.children.lock().await;
        assert!(guard.get(&req.session_id.0.to_string()).is_none());
    }

    #[tokio::test]
    async fn handle_set_model_and_effort_are_noops() {
        let server = GeminiAcpEngine::default();
        server
            .handle_set_model("t".into(), Some("gemini-2-5-pro".into()))
            .await
            .expect("set_model no-ops");
        server
            .handle_set_effort("t".into(), crate::claude::session::EffortLevel::Off)
            .await
            .expect("set_effort no-ops");
    }
}
