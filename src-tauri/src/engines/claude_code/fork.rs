//! Phase 8: session forking. ACP `session/fork` clones a session from a
//! chosen turn. The fork inherits the transcript up to that point — we
//! handle that by:
//!   1. Reading the source session's on-disk JSONL transcript
//!      (`~/.claude/projects/<hash>/<source_session_id>.jsonl`).
//!   2. Truncating to `up_to_turn` user turns.
//!   3. Writing a new JSONL file under the same projects dir but with
//!      the forked thread's claude_session_id (TBD on first prompt).
//!
//! For Phase 8 minimum we only persist the fork RELATIONSHIP in SQLite
//! (`branched_from + branched_from_turn`) and seed the new session's
//! `SessionOpts.resume_session_id` with the source's
//! `claude_session_id`. The first prompt on the forked thread spawns
//! `claude --resume <source_session_id>` after that, so the user
//! effectively continues the conversation in a separate thread sharing
//! the source's transcript up to that point. A future phase can copy
//! the JSONL byte-for-byte if we need true divergence at the file
//! level — TODO(phase-10/11).

use serde::Serialize;

/// Input to `ClaudeCodeEngine::handle_fork_session`. The frontend supplies a
/// source `threadId` (Ikenga's stable id, NOT claude's session id) and
/// optionally the turn index to fork from. `up_to_turn = None` means
/// "fork from the latest turn" — Phase 8 treats both cases identically
/// because we only record the relationship; the real cutoff lives in
/// the future transcript-copy step.
pub struct ForkRequest {
    pub source_thread_id: String,
    pub up_to_turn: Option<u32>, // None = fork from latest
    pub label: Option<String>,
}

/// Result of a successful fork. The new thread id is what the frontend
/// navigates to (`/sessions/$threadId`). `branched_from_turn` echoes
/// what the caller passed so the UI can re-display "branched from turn
/// N" without an extra round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub new_thread_id: String,
    pub source_thread_id: String,
    pub branched_from_turn: Option<u32>,
}

/// Reject obviously bogus inputs before we touch SQLite. We deliberately
/// don't validate that `source_thread_id` actually exists here — the
/// server does that via a `SELECT` so an unknown id surfaces as a clean
/// "no source thread" error path instead of a SQL FK violation.
pub fn validate_fork_request(req: &ForkRequest) -> Result<(), String> {
    if req.source_thread_id.is_empty() {
        return Err("source_thread_id is required".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_fork_request_rejects_empty_source() {
        let req = ForkRequest {
            source_thread_id: String::new(),
            up_to_turn: None,
            label: None,
        };
        let err = validate_fork_request(&req).expect_err("empty source should error");
        assert!(err.contains("source_thread_id"));
    }

    #[test]
    fn validate_fork_request_accepts_non_empty_source() {
        let req = ForkRequest {
            source_thread_id: "t_source".into(),
            up_to_turn: Some(3),
            label: Some("alt-direction".into()),
        };
        validate_fork_request(&req).expect("non-empty source ok");
    }
}
