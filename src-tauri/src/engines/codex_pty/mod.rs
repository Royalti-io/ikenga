//! `CodexPtyEngine` — Rust adapter that spawns the OpenAI Codex CLI inside a
//! PTY and shuttles its TUI output into the shell's internal `SessionUpdate`
//! stream (Phase 3 of the multi-engine rebuild).
//!
//! Codex doesn't ship a structured stream-json mode the way `claude` does;
//! it's a full-screen TUI with ANSI cursor positioning, box-drawing chrome,
//! and a `❯ ` (or `›`) idle-prompt marker. We treat it like the lowest
//! common denominator:
//!
//!   1. Strip ANSI escapes from each chunk.
//!   2. Split into lines, drop TUI chrome (`╭ │ ╰ ` and `>>` echo lines).
//!   3. Emit each remaining content line as an `agent_message_chunk` text.
//!   4. Treat an idle-prompt marker as "turn done" and return from the
//!      handler. Fall back to a 60s wallclock timeout so a model that
//!      hangs (network glitch, runaway tool) doesn't hold the UI hostage.
//!
//! Tool-use, thinking, model picker, permissions, OAuth flows — all
//! explicitly out of scope. When/if we replace this with the Zed
//! `@zed-industries/codex-acp` adapter, those capabilities can return.
//!
//! TODO(phase-3-integration): wire CodexPty into `engines::EngineHandle`,
//! `commands/chat.rs`, and `lib.rs`. A parallel agent owns those files
//! this session; this module exposes the `CodexPtyEngineState` alias so
//! the wire-up is a one-line addition once their refactor lands.

pub mod engine;
pub mod parser;

pub use engine::{CodexPtyEngine, CodexPtyEngineState};
