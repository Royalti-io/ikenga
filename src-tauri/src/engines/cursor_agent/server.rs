//! `CursorAgentEngine` — scaffold mirror of `GeminiAcpEngine`.
//!
//! Public method signatures mirror `GeminiAcpEngine` so `commands/chat.rs`
//! can dispatch to either via `EngineHandle`. Every runtime-bearing method
//! returns a typed error (`STUB_ERR`); no-op methods return `Ok(())` to
//! match gemini's "nothing to do for this engine" semantics.
//!
//! When ADR-013 Phase ~next swaps in real logic, the expectation is that
//! this file fills out like `gemini_acp/server.rs` — `children: HashMap<…,
//! Arc<CursorAgentChild>>`, `ensure_child` lazy spawn, JSON-RPC
//! request/notify over a sibling `transport.rs`.

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, LoadSessionResponse,
    NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ProtocolVersion,
    RequestPermissionResponse,
};
use std::sync::Arc;
use tauri::AppHandle;

/// Returned from every runtime-bearing method until the Cursor CLI is
/// installable + ACP-verifiable. Kept as a `&'static str` so callers
/// (`commands/chat.rs`, the FE error toast layer) can match on the exact
/// scaffold message if needed.
const STUB_ERR: &str = "cursor-agent runtime not implemented — see ADR-013 Phase 4";

/// Scaffold engine. Empty body — once Phase ~next lands, this struct gains
/// the same `children: TokioMutex<HashMap<String, Arc<CursorAgentChild>>>`
/// surface as `GeminiAcpEngine`.
pub struct CursorAgentEngine;

impl Default for CursorAgentEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl CursorAgentEngine {
    pub fn new() -> Self {
        Self
    }

    pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V1;

    /// ACP `initialize`. Returns a minimal response with no capabilities
    /// advertised — the scaffold can't do anything yet, so it shouldn't
    /// claim to. Once Phase ~next lands and the Cursor CLI is probed,
    /// this fills out like `gemini_acp::server::handle_initialize`.
    pub fn handle_initialize(&self, req: InitializeRequest) -> InitializeResponse {
        let negotiated = std::cmp::min(req.protocol_version, Self::PROTOCOL_VERSION);
        // Scaffold-only: advertise nothing. `AgentCapabilities::default()`
        // has all booleans `false` and no nested capability blocks, which
        // is the most honest "we can't do anything" advertisement.
        let agent_caps = AgentCapabilities::default();
        InitializeResponse::new(negotiated)
            .agent_capabilities(agent_caps)
            .auth_methods(Vec::new())
    }

    /// ACP `session/new`. Stubbed — real implementation will spawn a
    /// `cursor-agent --acp` child and forward `session/new` JSON-RPC.
    pub async fn handle_new_session(
        &self,
        _app: AppHandle,
        _req: NewSessionRequest,
    ) -> Result<NewSessionResponse, String> {
        Err(STUB_ERR.to_string())
    }

    /// ACP `session/prompt`. Stubbed.
    pub async fn handle_prompt(
        &self,
        _app: AppHandle,
        _req: PromptRequest,
    ) -> Result<PromptResponse, String> {
        Err(STUB_ERR.to_string())
    }

    /// ACP `session/cancel`. Matches gemini's "unknown thread is a no-op"
    /// semantics — cancelling a non-existent session never fails.
    pub async fn handle_cancel(&self, _thread_id: String) -> Result<(), String> {
        Ok(())
    }

    /// Resolve a parked permission round-trip. No waiters can exist (we
    /// never spawned a child), so this is always a silent `Ok(())`.
    /// Mirrors gemini's "no waiter, just log and return Ok" path.
    pub async fn resolve_permission(
        &self,
        _request_id: String,
        _response: RequestPermissionResponse,
    ) -> Result<(), String> {
        Ok(())
    }

    /// ACP `session/load`. Stubbed — would forward to the cursor-agent
    /// child's `session/load` method once the transport exists.
    pub async fn handle_load_session(
        &self,
        _thread_id: String,
        _cwd: String,
        _app: AppHandle,
    ) -> Result<LoadSessionResponse, String> {
        Err(STUB_ERR.to_string())
    }

    /// ACP `session/set_mode`. No-op for the scaffold (matches gemini's
    /// pattern of accepting mode changes silently when the engine
    /// doesn't expose a meaningful mode surface).
    pub async fn handle_set_mode(
        &self,
        _thread_id: String,
        _mode_id: String,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Set the session's model. No-op for the scaffold; the dispatcher in
    /// `commands/chat.rs` can call this uniformly without special-casing.
    pub async fn handle_set_model(
        &self,
        _thread_id: String,
        _model: Option<String>,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Set extended-thinking effort. No-op for the scaffold.
    pub async fn handle_set_effort(
        &self,
        _thread_id: String,
        _effort: crate::claude::session::EffortLevel,
    ) -> Result<(), String> {
        Ok(())
    }
}

/// Returned from `lib.rs::run()` for the `EngineRegistryState`. Same
/// `Arc<...>` shape as `GeminiAcpEngineState` so the registry can hold
/// either through the `EngineHandle` enum.
pub type CursorAgentEngineState = Arc<CursorAgentEngine>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_negotiated_version_with_no_capabilities() {
        let engine = CursorAgentEngine::default();
        let req = InitializeRequest::new(ProtocolVersion::V1);
        let resp = engine.handle_initialize(req);
        assert_eq!(resp.protocol_version, ProtocolVersion::V1);
        // Scaffold honesty: every capability flag stays default-false.
        assert!(!resp.agent_capabilities.load_session);
        assert!(!resp.agent_capabilities.prompt_capabilities.image);
        assert!(!resp.agent_capabilities.prompt_capabilities.audio);
        assert!(resp.auth_methods.is_empty());
    }

    #[test]
    fn stub_error_constant_matches_adr() {
        // Mirror of the contract `commands/chat.rs` arms rely on — if
        // this string drifts, the FE error toast story drifts with it.
        // Update both call sites in lockstep if the wording changes.
        assert_eq!(
            STUB_ERR,
            "cursor-agent runtime not implemented — see ADR-013 Phase 4"
        );
    }

    #[tokio::test]
    async fn handle_cancel_is_ok_for_any_thread() {
        // Stale Stop clicks must never fail — same contract as gemini.
        let engine = CursorAgentEngine::default();
        engine
            .handle_cancel("never-existed".into())
            .await
            .expect("cancel on absent thread should be Ok");
    }

    #[tokio::test]
    async fn handle_set_model_and_effort_are_noops() {
        let engine = CursorAgentEngine::default();
        engine
            .handle_set_model("t".into(), Some("cursor-default".into()))
            .await
            .expect("set_model no-ops");
        engine
            .handle_set_effort("t".into(), crate::claude::session::EffortLevel::Off)
            .await
            .expect("set_effort no-ops");
        engine
            .handle_set_mode("t".into(), "default".into())
            .await
            .expect("set_mode no-ops");
    }

    #[tokio::test]
    async fn resolve_permission_is_ok() {
        let engine = CursorAgentEngine::default();
        // The RequestPermissionResponse type's constructor varies by
        // schema crate version; use serde_json to build a minimal value
        // and let it decode. If that fails the test catches it.
        let response: RequestPermissionResponse =
            serde_json::from_value(serde_json::json!({ "outcome": { "outcome": "cancelled" } }))
                .expect("RequestPermissionResponse decodes");
        engine
            .resolve_permission("req-1".into(), response)
            .await
            .expect("resolve_permission no-ops");
    }
}
