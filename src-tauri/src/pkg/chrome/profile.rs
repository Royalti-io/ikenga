//! Managed Chrome dedicated-profile resolver (WP-03).
//!
//! A "managed profile" is a `--user-data-dir` Chrome is launched with by the
//! Ikenga shell. Each profile has a stable on-disk path so the lifecycle layer
//! (WP-04) can reattach to an already-running Chrome or clear a stale
//! `SingletonLock` on restart without guessing the dir.
//!
//! Profiles live under:
//!   `<app_data_dir>/chrome-profiles/<sanitized-name>/`
//!
//! The app data dir is resolved with the same platform conventions Tauri uses
//! internally (same approach as `crate::vault_key`), so the path is stable
//! across `App::run` and standalone unit-test contexts.
//!
//! Name sanitization keeps only alphanumeric chars + `-`, `_`, and `.`; strips
//! any leading dots (macOS hidden-file convention + path-traversal guard); and
//! rejects empty or path-traversal names with an error.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

/// Tauri bundle identifier — must match `tauri.conf.json` `identifier`.
const BUNDLE_ID: &str = "app.ikenga";

/// Resolve the `app_data_dir` without a Tauri `AppHandle`, using the same
/// platform-specific rules Tauri's internal `PathResolver` applies.
///
/// Matches the implementation in `crate::vault_key` (kept in sync manually;
/// both reference the same `BUNDLE_ID`).
fn app_data_dir() -> Result<PathBuf> {
    let dir: PathBuf = if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| anyhow!("$HOME is not set (needed to resolve app_data_dir)"))?;
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(BUNDLE_ID)
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| anyhow!("%APPDATA% is not set (needed to resolve app_data_dir)"))?;
        PathBuf::from(appdata).join(BUNDLE_ID)
    } else {
        // Linux + other unixes: prefer $XDG_DATA_HOME, fall back to ~/.local/share
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            PathBuf::from(xdg).join(BUNDLE_ID)
        } else {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| anyhow!("$HOME is not set (needed to resolve app_data_dir)"))?;
            PathBuf::from(home).join(".local/share").join(BUNDLE_ID)
        }
    };
    Ok(dir)
}

/// Sanitize a caller-supplied profile name to a safe filesystem component.
///
/// Rules:
/// - Keep only ASCII alphanumeric, `-`, `_`, `.`
/// - Strip leading dots (macOS hidden-file + `./../` traversal guard)
/// - The result must be non-empty and must not equal `.` or `..`
/// - Path separators (`/`, `\`) and null bytes are rejected implicitly (they
///   aren't alphanumeric or in the allowed set)
pub fn sanitize_profile_name(name: &str) -> Result<String> {
    if name.is_empty() {
        return Err(anyhow!("profile name must not be empty"));
    }

    let filtered: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();

    // Strip leading dots to prevent hidden-file / traversal names like `.` `..`
    let sanitized = filtered.trim_start_matches('.').to_string();

    if sanitized.is_empty() {
        return Err(anyhow!(
            "profile name {:?} contains no safe characters after sanitization",
            name
        ));
    }
    if sanitized == "." || sanitized == ".." {
        return Err(anyhow!(
            "profile name {:?} resolves to an unsafe path component",
            name
        ));
    }

    Ok(sanitized)
}

/// Resolve (and create if absent) the dedicated `--user-data-dir` for a named
/// Managed Chrome profile.
///
/// The dir is `<app_data_dir>/chrome-profiles/<sanitized-name>/`. If the dir
/// does not exist it is created (including all parents). The returned path is
/// always absolute.
///
/// # Errors
///
/// Returns an error if the name is unsafe, if the app data dir cannot be
/// determined, or if the directory cannot be created.
pub fn managed_profile_dir(profile_name: &str) -> Result<PathBuf> {
    let dir = profile_dir_under(&app_data_dir()?, profile_name)?;

    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("create managed profile dir {}: {e}", dir.display()))?;

    Ok(dir)
}

/// Pure path computation: `<root>/chrome-profiles/<sanitized-name>/`. Does not
/// touch the filesystem or read the environment, so it is deterministically
/// testable. `managed_profile_dir` layers env-resolution + dir-creation on top.
fn profile_dir_under(root: &Path, profile_name: &str) -> Result<PathBuf> {
    let safe_name = sanitize_profile_name(profile_name)?;
    Ok(root.join("chrome-profiles").join(safe_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_profile_name ────────────────────────────────────────────────

    #[test]
    fn sanitize_normal_name() {
        assert_eq!(sanitize_profile_name("default").unwrap(), "default");
        assert_eq!(sanitize_profile_name("my-profile").unwrap(), "my-profile");
        assert_eq!(sanitize_profile_name("user_1").unwrap(), "user_1");
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        // spaces, slashes, null bytes, unicode → removed
        assert_eq!(sanitize_profile_name("a b/c").unwrap(), "abc");
        assert_eq!(sanitize_profile_name("hello world!").unwrap(), "helloworld");
    }

    #[test]
    fn sanitize_strips_leading_dots() {
        // Prevents ./, ../, hidden-file names
        assert_eq!(sanitize_profile_name(".hidden").unwrap(), "hidden");
        assert_eq!(sanitize_profile_name("...name").unwrap(), "name");
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_profile_name("").is_err());
    }

    #[test]
    fn sanitize_rejects_all_illegal() {
        // e.g. a name that is pure whitespace or special chars
        assert!(sanitize_profile_name("   ").is_err());
        assert!(sanitize_profile_name("!!!").is_err());
    }

    #[test]
    fn sanitize_rejects_dotdot() {
        // After filtering only `.` chars remain → stripped entirely
        // (a string like ".." after filtering is ".." but leading-dot stripping
        // removes leading "." so ".." → "." → we check again)
        // "..." → all dots → stripped entirely → error
        assert!(sanitize_profile_name("...").is_err());
    }

    // ── profile_dir_under (pure path logic — no env, no filesystem) ──────────
    // We test the pure helper rather than `managed_profile_dir` so the suite
    // never mutates the global `HOME`/`XDG_DATA_HOME` env (which would race the
    // parallel test runner and, on Linux-with-XDG, write to the real data dir).
    // The thin env-resolve + dir-create wrapper is exercised by the WP-10 smoke.

    #[test]
    fn profile_dir_is_stable_and_under_root() {
        let root = Path::new("/data/app.ikenga");
        let dir = profile_dir_under(root, "default").expect("resolve default profile");

        assert!(dir.starts_with(root), "profile dir {dir:?} not under root {root:?}");
        assert!(
            dir.ends_with("chrome-profiles/default"),
            "unexpected path tail: {dir:?}"
        );
        // Deterministic / idempotent.
        let dir2 = profile_dir_under(root, "default").expect("second call");
        assert_eq!(dir, dir2, "second call returned a different path");
    }

    #[test]
    fn profile_dir_sanitizes_name_in_path() {
        let root = Path::new("/data/app.ikenga");
        let dir = profile_dir_under(root, "my profile!").expect("sanitized name");
        // Spaces and ! stripped → "myprofile"
        assert!(
            dir.ends_with("chrome-profiles/myprofile"),
            "unexpected path: {dir:?}"
        );
    }

    #[test]
    fn profile_dir_neutralizes_traversal_and_rejects_empty() {
        let root = Path::new("/data/app.ikenga");
        // Traversal input is NEUTRALIZED (slashes + leading dots stripped), not
        // errored — the resulting path stays safely under root. This is the
        // security property: a malicious name can't escape the profiles subtree.
        let dir = profile_dir_under(root, "../../etc/passwd").expect("neutralized");
        assert!(dir.starts_with(root), "traversal escaped root: {dir:?}");
        assert!(
            dir.ends_with("chrome-profiles/etcpasswd"),
            "unexpected neutralized path: {dir:?}"
        );
        // Empty / all-illegal names DO error (nothing safe survives sanitization).
        assert!(profile_dir_under(root, "").is_err());
        assert!(profile_dir_under(root, "///").is_err());
    }
}
