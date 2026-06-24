//! Installed-Chrome detection (cross-OS).
//!
//! Ports the canonical path list from the npm `chrome-launcher` package so we
//! resolve the user's *installed* Google Chrome (Managed mode never downloads a
//! browser). Resolution priority:
//!
//! 1. `CHROME_PATH` env override (highest — lets a user pin an exact binary).
//! 2. Per-OS well-known install locations (macOS app bundle / Windows Program
//!    Files / Linux PATH binaries), in descending preference (stable → beta →
//!    Canary/dev → chromium).
//!
//! Returns [`ChromeInstall`] (`{ path, version }`) or a typed [`DetectError`].
//! The version string is parsed from `<binary> --version` (e.g.
//! `"Google Chrome 149.0.7258.5 "` → `"149.0.7258.5"`).
//!
//! v1 is Linux/Chrome-149-verified; the macOS/Windows path lists are ported for
//! completeness (cross-OS detection is otherwise Phase 3 per the orchestration
//! doc) and compiled but only exercised on their target OS.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A detected, on-disk Chrome (or Chromium) install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromeInstall {
    /// Absolute path to the executable.
    pub path: PathBuf,
    /// Parsed version (e.g. `"149.0.7258.5"`). Empty-string-safe: if
    /// `--version` output can't be parsed we still surface whatever it printed,
    /// trimmed; a fully empty result becomes `"unknown"`.
    pub version: String,
}

/// Why detection failed. Hand-written `Display`/`Error` (no `thiserror` direct
/// dep) so this module stays within its declared Cargo footprint (chromiumoxide
/// only). Converts cleanly into `anyhow::Error` via the blanket `std::error`
/// impl, so the launcher's `anyhow::Result` swallows it with `?`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectError {
    /// No Chrome binary found at the `CHROME_PATH` override nor any well-known
    /// location for this OS.
    NotFound,
    /// `CHROME_PATH` was set but points at a path that doesn't exist or isn't a
    /// file. We fail loudly rather than silently falling back, so a typo in the
    /// override surfaces instead of launching some other Chrome.
    OverrideMissing(PathBuf),
}

impl std::fmt::Display for DetectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(
                f,
                "no Google Chrome install found (set CHROME_PATH to override, or \
                 install Chrome / Chromium)"
            ),
            Self::OverrideMissing(p) => write!(
                f,
                "CHROME_PATH points at `{}`, which does not exist or is not a file",
                p.display()
            ),
        }
    }
}

impl std::error::Error for DetectError {}

/// Detect the installed Chrome. See module docs for resolution order.
pub fn detect_chrome() -> Result<ChromeInstall, DetectError> {
    // 1. CHROME_PATH override wins outright.
    if let Some(raw) = std::env::var_os("CHROME_PATH") {
        let p = PathBuf::from(&raw);
        if !p.is_empty_os() {
            if is_executable_file(&p) {
                return Ok(make_install(p));
            }
            return Err(DetectError::OverrideMissing(p));
        }
    }

    // 2. First existing candidate from the per-OS list.
    for cand in candidate_paths() {
        if is_executable_file(&cand) {
            return Ok(make_install(cand));
        }
    }

    Err(DetectError::NotFound)
}

/// Build a [`ChromeInstall`], reading the version from `--version`.
fn make_install(path: PathBuf) -> ChromeInstall {
    let version = read_version(&path);
    ChromeInstall { path, version }
}

/// Run `<binary> --version` and parse the trailing dotted version token.
/// Chrome prints e.g. `Google Chrome 149.0.7258.5`; Chromium prints e.g.
/// `Chromium 149.0.7258.0`. We pull the first whitespace-separated token that
/// looks like a dotted-numeric version; failing that we trim the whole line.
fn read_version(path: &Path) -> String {
    let out = Command::new(path).arg("--version").output();
    let raw = match out {
        Ok(o) if o.status.success() || !o.stdout.is_empty() => {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        _ => return "unknown".to_string(),
    };
    parse_version(&raw)
}

/// Extract the dotted-numeric version token from a `--version` line.
fn parse_version(raw: &str) -> String {
    for tok in raw.split_whitespace() {
        // A version token is digits + dots, with at least one dot.
        if tok.contains('.') && tok.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return tok.to_string();
        }
    }
    if raw.is_empty() {
        "unknown".to_string()
    } else {
        raw.to_string()
    }
}

/// True when `p` exists and is a regular file (the OS will reject a non-exec on
/// spawn; we don't stat the exec bit here because it's not portable and a
/// well-known Chrome path is executable by construction).
fn is_executable_file(p: &Path) -> bool {
    p.is_file()
}

/// Helper: treat an empty `OsString` path as "unset".
trait IsEmptyOs {
    fn is_empty_os(&self) -> bool;
}
impl IsEmptyOs for PathBuf {
    fn is_empty_os(&self) -> bool {
        self.as_os_str().is_empty()
    }
}

// ── Per-OS candidate path lists (ported from chrome-launcher) ────────────────

#[cfg(target_os = "macos")]
fn candidate_paths() -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from(
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ),
    ];
    // Per-user ~/Applications variants (chrome-launcher checks these too).
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(
            "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        v.push(home.join(
            "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ));
    }
    v
}

#[cfg(target_os = "windows")]
fn candidate_paths() -> Vec<PathBuf> {
    // chrome-launcher walks %LOCALAPPDATA%, %PROGRAMFILES%, %PROGRAMFILES(X86)%
    // for both stable (Google\Chrome\Application\chrome.exe) and SxS/Canary
    // (Google\Chrome SxS\Application\chrome.exe).
    let mut v = Vec::new();
    let roots = [
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
    ];
    for root in roots.into_iter().flatten() {
        let root = PathBuf::from(root);
        v.push(root.join("Google\\Chrome\\Application\\chrome.exe"));
        v.push(root.join("Google\\Chrome SxS\\Application\\chrome.exe"));
    }
    v
}

#[cfg(target_os = "linux")]
fn candidate_paths() -> Vec<PathBuf> {
    // On Linux Chrome lives on PATH under one of several binary names. Resolve
    // each against PATH (mirrors `command -v` from spike S1) plus the canonical
    // absolute fallbacks, in descending preference.
    const NAMES: &[&str] = &[
        "google-chrome-stable",
        "google-chrome",
        "google-chrome-beta",
        "google-chrome-unstable",
        "chromium-browser",
        "chromium",
    ];
    let mut v = Vec::new();
    for name in NAMES {
        if let Some(p) = which_on_path(name) {
            v.push(p);
        }
    }
    // Absolute fallbacks for the common distro install dirs, in case PATH is
    // sparse (e.g. a headless service env).
    for abs in [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
    ] {
        v.push(PathBuf::from(abs));
    }
    v
}

/// Minimal `command -v <name>`: scan `$PATH` for an existing file named `name`.
#[cfg(target_os = "linux")]
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_google_chrome_version_line() {
        assert_eq!(parse_version("Google Chrome 149.0.7258.5 "), "149.0.7258.5");
    }

    #[test]
    fn parses_chromium_version_line() {
        assert_eq!(parse_version("Chromium 149.0.7258.0"), "149.0.7258.0");
    }

    #[test]
    fn unparseable_version_falls_back_to_trimmed_line() {
        assert_eq!(parse_version("weird output"), "weird output");
        assert_eq!(parse_version(""), "unknown");
    }

    #[test]
    fn candidate_paths_is_non_empty() {
        // Each OS list should offer at least one candidate to probe.
        assert!(!candidate_paths().is_empty());
    }
}
