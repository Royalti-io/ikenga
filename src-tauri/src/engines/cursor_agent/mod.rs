//! Cursor-agent engine adapter — **scaffold-only** per ADR-013 Phase 4.
//!
//! This module exists so the multi-engine dispatcher in
//! `commands/chat.rs`, the `EngineRegistry` in `engines/mod.rs`, and the
//! frontend's engine catalog can all carry a stable `"cursor-agent"`
//! engine id today, without committing to a runtime body that hasn't been
//! verified against a real CLI yet.
//!
//! Expected shape (once the Cursor CLI is installable and an
//! `--acp`-equivalent flag is verified): ACP passthrough, structurally
//! identical to `gemini_acp` — spawn `cursor-agent --acp` (or whatever the
//! eventual flag is), proxy JSON-RPC bidirectionally over stdio, reuse
//! `agent-client-protocol`'s `SessionUpdate` / `PromptRequest` /
//! `RequestPermissionRequest` types verbatim. The file layout here
//! mirrors `gemini_acp/` deliberately so the Phase-next swap is a content
//! diff, not a structural one.
//!
//! Until then **every runtime method returns**
//! `Err("cursor-agent runtime not implemented — see ADR-013 Phase 4")`.
//! `handle_initialize` returns a minimal `InitializeResponse` advertising
//! no capabilities; the no-op methods (`handle_cancel`, `set_mode`,
//! `set_model`, `set_effort`, `resolve_permission`) return `Ok(())` to
//! match `gemini_acp`'s semantics for "nothing to do" cases.
//!
//! No `transport` submodule lives here yet — there is no wire protocol
//! to implement until the CLI is on disk and probeable.

pub mod server;

pub use server::{CursorAgentEngine, CursorAgentEngineState};
