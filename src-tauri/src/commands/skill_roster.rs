//! Generic read command for per-project Atelier skill files.
//!
//! Atelier skills persist their per-project config under a well-known layout:
//! `<project_root>/.atelier/<skill>/<file>` (e.g. the Tasks pkg's roster lives
//! at `.atelier/skill-tasks/roster.json`, written by `skill-tasks setup`). The
//! shell reads these at iframe-mount time and injects the parsed result into a
//! pkg's `hostContext` (see `06-skill-action-contract.md`). This command is the
//! one generic reader; callers name the `<skill>`/`<file>` — the roster read is
//! just `atelier_file_read(root, "skill-tasks", "roster.json")` on the FE.
//!
//! # Security model
//!
//! The `project_root` argument comes from the shell's own `projects` table
//! (via `useShellStore.getState().projects`), not from untrusted pkg input.
//! The `.atelier` prefix is a compile-time constant, and both the `skill` and
//! `file` segments are validated (`is_safe_segment`) to reject path traversal
//! (`..`) and embedded separators, so a caller cannot read outside
//! `<project_root>/.atelier/`. This is analogous to how `agent_ops` reads
//! `$HOME/.agent-ops/…` without routing through the FS allowlist — privileged
//! intra-app reads keyed to well-known project data, not arbitrary paths.
//!
//! # Return value
//!
//! Returns the raw file contents on success. Returns `None` when the file is
//! absent, the project root is `None`/empty, a segment is unsafe, or any IO
//! error occurs. The caller (FE) is responsible for parsing and validation; an
//! absent or malformed file causes the consuming pkg to fall back to its static
//! defaults.

use std::path::PathBuf;

/// A single path segment (`skill` or `file`) is safe iff it is non-empty and
/// contains no path separator or `..` traversal sequence. Normal filenames with
/// dots (`roster.json`) are allowed; only traversal is blocked.
fn is_safe_segment(seg: &str) -> bool {
    !seg.is_empty() && !seg.contains('/') && !seg.contains('\\') && !seg.contains("..")
}

/// Read `<project_root>/.atelier/<skill>/<file>`.
///
/// `project_root` is the project's `root_path` column from the `projects`
/// table — an absolute path string, or `None` for the default project that has
/// no root configured. Returns `None` on any error (absent file, permission
/// denied, unset root, unsafe segment) so the FE falls back silently.
#[tauri::command]
pub async fn atelier_file_read(
    project_root: Option<String>,
    skill: String,
    file: String,
) -> Option<String> {
    let root = project_root.as_deref().filter(|s| !s.is_empty())?;
    if !is_safe_segment(&skill) || !is_safe_segment(&file) {
        tracing::warn!(
            skill = %skill,
            file = %file,
            "atelier_file_read: rejected unsafe path segment"
        );
        return None;
    }
    let path = PathBuf::from(root).join(".atelier").join(&skill).join(&file);
    match std::fs::read_to_string(&path) {
        Ok(contents) => Some(contents),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                // Log unexpected errors (permissions, etc.) but still return
                // None — the FE static fallback handles it gracefully.
                tracing::debug!(
                    path = %path.display(),
                    error = %e,
                    "atelier_file_read: could not read file"
                );
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segments_accepted() {
        for seg in ["skill-tasks", "roster.json", "skill-agent-ops", "jobs.json"] {
            assert!(is_safe_segment(seg), "expected safe: {seg:?}");
        }
    }

    #[test]
    fn traversal_and_separators_rejected() {
        for seg in ["", "..", "../etc", "a/b", "a\\b", "..\\x", "foo/..", "."] {
            // `.` alone is harmless but not a real skill/file; only `..` and
            // separators must be rejected. Assert the traversal cases here.
            if seg == "." {
                assert!(is_safe_segment(seg), "bare dot has no traversal: {seg:?}");
            } else {
                assert!(!is_safe_segment(seg), "expected rejected: {seg:?}");
            }
        }
    }

    #[tokio::test]
    async fn none_root_returns_none_without_fs_access() {
        assert!(
            atelier_file_read(None, "skill-tasks".into(), "roster.json".into())
                .await
                .is_none()
        );
        assert!(
            atelier_file_read(Some(String::new()), "skill-tasks".into(), "roster.json".into())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn unsafe_segment_returns_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_string_lossy().to_string();
        assert!(
            atelier_file_read(Some(root.clone()), "..".into(), "roster.json".into())
                .await
                .is_none()
        );
        assert!(
            atelier_file_read(Some(root), "skill-tasks".into(), "../../etc/passwd".into())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn reads_existing_atelier_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join(".atelier").join("skill-tasks");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("roster.json"), r#"{"ok":true}"#).expect("write");

        let got = atelier_file_read(
            Some(tmp.path().to_string_lossy().to_string()),
            "skill-tasks".into(),
            "roster.json".into(),
        )
        .await;
        assert_eq!(got.as_deref(), Some(r#"{"ok":true}"#));
    }
}
