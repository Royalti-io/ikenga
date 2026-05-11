//! Agent Client Protocol surface for Ikenga.
//!
//! We're a Rust ACP **server** wrapping the user's `claude` binary. The
//! wire-format/JSON-RPC layer of the `agent-client-protocol` crate is NOT
//! used today — we expose this surface through Tauri commands instead, so
//! the frontend (which speaks ACP types from `@agentclientprotocol/sdk`)
//! calls our handlers in-process with no subprocess hop. We can swap to
//! actual stdio JSON-RPC later if we want Zed/another shell to consume us
//! as an ACP agent — the type vocabulary is already aligned.
//!
//! Architectural decision lives in `~/.claude/.../memory/project_acp_engine_decision.md`.
//!
//! Memory features (CLAUDE.md, auto-memory, /memory, /compact, --resume,
//! `#` shortcuts) come from the `claude` binary itself — we never pull in
//! the Node `@anthropic-ai/claude-agent-sdk` package. The bridge below
//! translates between ACP requests and stream-json envelopes spoken by
//! `claude --print --input-format stream-json --output-format stream-json
//! --permission-prompt-tool stdio`.
//!
//! Modules:
//!  - `server` — top-level dispatch + state. Owns the per-thread
//!    sessions; routes ACP method calls to the right handler. (Phase 1.)
//!  - `mapping` — translates `claude/event::ChatEvent` → ACP
//!    `SessionUpdate` notifications, and back. (Phase 2.)

pub mod interrupt;
pub mod mapping;
pub mod mode;
pub mod permission;
pub mod prompt;
pub mod server;

#[cfg(test)]
mod tests {
    /// Smoke test: the schema types we depend on actually link in.
    /// If this fails to compile, the crate dep is broken.
    #[test]
    fn schema_types_link() {
        use agent_client_protocol::schema::{
            InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse,
            PromptRequest, PromptResponse, SessionNotification, SessionUpdate, StopReason,
        };
        // Discard — we only care this typechecks.
        let _ = std::mem::size_of::<InitializeRequest>();
        let _ = std::mem::size_of::<InitializeResponse>();
        let _ = std::mem::size_of::<NewSessionRequest>();
        let _ = std::mem::size_of::<NewSessionResponse>();
        let _ = std::mem::size_of::<PromptRequest>();
        let _ = std::mem::size_of::<PromptResponse>();
        let _ = std::mem::size_of::<SessionNotification>();
        let _ = std::mem::size_of::<SessionUpdate>();
        let _ = std::mem::size_of::<StopReason>();
    }
}
