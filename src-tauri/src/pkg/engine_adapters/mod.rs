//! Concrete `EngineAdapter` implementations (ADR-012 Track D).
//!
//! Layout: one module per engine adapter. Today only `claude_code` exists;
//! `gemini` and `codex` will land alongside their engine pkgs per ADR §10
//! phase 6. The trait + registry live in `pkg::engine_adapter`.

pub mod claude_code;
pub mod codex;
pub mod gemini;
mod symlink;
pub(crate) mod transcoder;

#[cfg(test)]
mod test_util;

pub use claude_code::ClaudeCodeAdapter;
pub use codex::CodexAdapter;
pub use gemini::GeminiAdapter;
