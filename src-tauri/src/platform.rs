//! Cross-platform user-home + shell helpers.
//!
//! The rest of the codebase used to read `$HOME` directly, which is unset
//! on Windows and produced "HOME not set" install failures. Route every
//! callsite through `home_dir()` so Windows can fall back to `%USERPROFILE%`
//! (and, as a last resort, `%HOMEDRIVE%%HOMEPATH%`).

use std::path::PathBuf;

/// Resolve the current user's home directory. Returns `None` only when no
/// reasonable env-var hint is set (effectively never on a real user session).
pub fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        if let Some(p) = std::env::var_os("USERPROFILE") {
            let pb = PathBuf::from(p);
            if !pb.as_os_str().is_empty() {
                return Some(pb);
            }
        }
        match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            (Some(drive), Some(path)) => {
                let mut s = drive;
                s.push(&path);
                let pb = PathBuf::from(s);
                if !pb.as_os_str().is_empty() {
                    return Some(pb);
                }
            }
            _ => {}
        }
        // POSIX-style $HOME is sometimes set under MSYS / Git-Bash; honor
        // it as a last resort so those shells aren't broken.
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    }
}

/// Platform-default interactive shell argv for a fresh terminal pane.
/// Windows prefers PowerShell (always present); falls back to `cmd.exe` when
/// PowerShell isn't on PATH. POSIX defaults to the user's `$SHELL` or bash.
pub fn default_shell_argv() -> Vec<String> {
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 (`pwsh`) when available; otherwise the inbox
        // `powershell.exe` (Windows PowerShell 5.1, ships with every supported
        // Windows version). Fall back to `cmd.exe` if neither resolves —
        // shouldn't happen on a real Windows box, but keeps the spawn path
        // honest.
        if which::which("pwsh").is_ok() {
            return vec!["pwsh".to_string(), "-NoLogo".to_string()];
        }
        if which::which("powershell").is_ok() {
            return vec!["powershell.exe".to_string(), "-NoLogo".to_string()];
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        return vec![comspec];
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        vec![shell, "-l".to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_resolves_on_unix() {
        // On the CI hosts we run, HOME is always set. Don't assert content —
        // just that we get *something* back.
        #[cfg(not(windows))]
        {
            if std::env::var_os("HOME").is_some() {
                assert!(home_dir().is_some());
            }
        }
    }

    #[test]
    fn default_shell_argv_non_empty() {
        let argv = default_shell_argv();
        assert!(!argv.is_empty());
        assert!(!argv[0].is_empty());
    }
}
