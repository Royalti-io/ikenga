//! Single-purpose read command for the per-project Atelier roster file.
//!
//! The file is written by `skill-tasks setup` (WP-06 setup lifecycle) and
//! lives at `<project_root>/.atelier/skill-tasks/roster.json`. The shell
//! reads it at iframe-mount time and injects it into the Tasks pkg's
//! `hostContext.royaltiSuite.tasksRoster` (see `06-skill-action-contract.md`
//! §Roster-config).
//!
//! # Security model
//!
//! The `project_root` argument comes from the shell's own `projects` table
//! (via `useShellStore.getState().projects`), not from untrusted pkg input.
//! The sub-path `.atelier/skill-tasks/roster.json` is a compile-time constant;
//! callers cannot traverse outside the project root.  This is analogous to how
//! `agent_ops` reads `$HOME/.agent-ops/…` without routing through the FS
//! allowlist — both are privileged intra-app reads keyed to well-known project
//! data, not arbitrary user-supplied paths.
//!
//! # Return value
//!
//! Returns the raw JSON string on success.  Returns `None` when the file is
//! absent, the project root is `None`/empty, or any IO error occurs.  The
//! caller (FE) is responsible for parsing and validation; an absent or
//! malformed roster causes the Tasks pkg to fall back to its static defaults.

use std::path::PathBuf;

/// Read `.atelier/skill-tasks/roster.json` from `project_root`.
///
/// `project_root` is the project's `root_path` column from the `projects`
/// table — an absolute path string, or `None` for the default project that
/// has no root configured.  Returns `None` on any error (absent file,
/// permission denied, unset root) so the FE falls back silently.
#[tauri::command]
pub async fn skill_roster_read(project_root: Option<String>) -> Option<String> {
    let root = project_root.as_deref().filter(|s| !s.is_empty())?;
    let path = PathBuf::from(root).join(".atelier/skill-tasks/roster.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => Some(contents),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                // Log unexpected errors (permissions, etc.) but still return
                // None — the FE static fallback handles it gracefully.
                tracing::debug!(
                    path = %path.display(),
                    error = %e,
                    "skill_roster_read: could not read roster file"
                );
            }
            None
        }
    }
}
