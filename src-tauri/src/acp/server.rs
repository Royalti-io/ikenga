//! ACP server skeleton.
//!
//! Phase 1: just enough to handle the `initialize` handshake — advertise
//! the capabilities we'll grow into, return a stable protocol version,
//! and otherwise be a no-op. Phase 2 wires prompt handling through to
//! the existing `claude::session` module.
//!
//! This file deliberately keeps the `agent-client-protocol` surface
//! contained — callers (Tauri command handlers, eventually the engine
//! pkg) only touch the methods on `AcpServer`, not the underlying
//! schema crate directly. That gives us a single place to absorb spec
//! churn.

use std::sync::Arc;

use agent_client_protocol::schema::{
    AgentCapabilities, InitializeRequest, InitializeResponse, McpCapabilities, PromptCapabilities,
    ProtocolVersion,
};

/// Top-level ACP server. Owns no state in phase 1; phase 2 adds a handle
/// to the existing `SessionsManager` so prompts route through to the
/// running `claude` children.
pub struct AcpServer {
    // Reserved for phase 2+. A handle to the sessions manager will live
    // here once `session/prompt` is wired to actual spawn/send work.
    _placeholder: (),
}

impl Default for AcpServer {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpServer {
    pub fn new() -> Self {
        Self { _placeholder: () }
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
}

/// Tauri-friendly wrapper around the server. Future phases will add
/// `tauri::State<Arc<AcpServerState>>` to the command handlers.
pub type AcpServerState = Arc<AcpServer>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_negotiated_version_and_capabilities() {
        let server = AcpServer::new();
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
        let server = AcpServer::new();
        let req = InitializeRequest::new(ProtocolVersion::V1);
        let resp = server.handle_initialize(req);
        assert!(resp.protocol_version <= AcpServer::PROTOCOL_VERSION);
    }
}
