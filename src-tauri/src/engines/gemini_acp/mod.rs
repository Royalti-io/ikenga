//! Gemini ACP engine adapter.
//!
//! Spawns `gemini --experimental-acp` as a child process and bridges its
//! stdio JSON-RPC stream into the same `chat://session/{id}` Tauri events
//! the Claude engine emits. Gemini is a native ACP peer — `SessionUpdate` /
//! `RequestPermissionRequest` shapes match the schema crate's types
//! directly, so no per-event translation is required.
//!
//! Unlike `claude_code` (which wraps the user's `claude` binary in-process
//! and bypasses the JSON-RPC wire layer), this engine actually speaks ACP
//! over stdio because gemini's CLI is a real ACP server. The bare-tokio
//! approach (rather than `agent-client-protocol-tokio`'s actor model) was
//! chosen because we need to keep a single child alive across many prompts
//! per session and the actor crate's `Client.builder().connect_with(...)`
//! shape fights that lifecycle.
//!
//! Modules:
//!  - `transport` — child process spawn + line-delimited JSON-RPC reader/writer.
//!  - `server`    — `GeminiAcpEngine` struct with the same public surface
//!                  as `ClaudeCodeEngine` so the multi-engine dispatcher in
//!                  `commands/chat.rs` can call either.

pub mod server;
pub mod transport;

pub use server::{GeminiAcpEngine, GeminiAcpEngineState};
