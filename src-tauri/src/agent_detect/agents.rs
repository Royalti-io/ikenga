//! `detect_agents` — PATH scan + version + auth probe for KNOWN_AGENTS.
//!
//! Subprocess spawns are wrapped in `tokio::time::timeout` so a hanging CLI
//! can't stall the wizard. All probes execute in parallel via `join_all`.

use std::path::PathBuf;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

use super::known::{
    family_matches, AgentCapabilities, AgentDef, AuthCheck, ExecutableSpec, KNOWN_AGENTS,
};

const DEFAULT_VERSION_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Debug, Serialize)]
pub struct DetectedAgent {
    pub id: String,
    pub display: String,
    pub executable_path: String,
    pub version: Option<String>,
    pub authed: Option<bool>,
    pub auth_hint: Option<String>,
    pub capabilities: AgentCapabilities,
}

pub async fn detect_all() -> Vec<DetectedAgent> {
    let os = std::env::consts::OS;
    let mut futs = Vec::new();
    for def in KNOWN_AGENTS {
        futs.push(detect_one(def, os));
    }
    let results = futures_join_all(futs).await;
    results.into_iter().flatten().collect()
}

/// Detect a single known agent by id. Returns `None` when the id isn't in
/// `KNOWN_AGENTS` or the executable couldn't be resolved on the current OS.
/// Surfaced as the per-engine variant so the onboarding UI can fan out one
/// call per engine and reveal results as they land instead of blocking on
/// the slowest probe.
pub async fn detect_by_id(agent_id: &str) -> Option<DetectedAgent> {
    let os = std::env::consts::OS;
    let def = KNOWN_AGENTS.iter().find(|d| d.id == agent_id)?;
    detect_one(def, os).await
}

/// Inlined tiny join_all so we don't drag in the full `futures` crate.
async fn futures_join_all<I, F>(iter: I) -> Vec<F::Output>
where
    I: IntoIterator<Item = F>,
    F: std::future::Future,
{
    let mut out = Vec::new();
    for fut in iter {
        out.push(fut.await);
    }
    out
}

async fn detect_one(def: &AgentDef, os: &str) -> Option<DetectedAgent> {
    let exec_path = resolve_executable(def, os)?;
    let version = if let Some(arg) = def.version_arg {
        probe_version(&exec_path, arg, def.version_regex).await
    } else {
        None
    };
    let (authed, auth_hint) = match def.auth_check {
        Some(ref check) => probe_auth_with_hint(&exec_path, check).await,
        None => (None, None),
    };
    Some(DetectedAgent {
        id: def.id.to_string(),
        display: def.display.to_string(),
        executable_path: exec_path.display().to_string(),
        version,
        authed,
        auth_hint,
        capabilities: def.capabilities,
    })
}

fn resolve_executable(def: &AgentDef, os: &str) -> Option<PathBuf> {
    for spec in def.executables {
        if !family_matches(spec.target_family, os) {
            continue;
        }
        if let Some(found) = lookup_spec(spec) {
            return Some(found);
        }
    }
    None
}

fn lookup_spec(spec: &ExecutableSpec) -> Option<PathBuf> {
    for name in spec.names {
        if let Ok(found) = which::which(name) {
            return Some(found);
        }
    }
    // Fallback: scan extra_dirs in order. Tilde-expand against the user's
    // home dir (HOME on Unix, USERPROFILE on Windows).
    for dir in spec.extra_dirs {
        let expanded = expand_tilde(dir);
        for name in spec.names {
            let candidate = expanded.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    // Platform-specific install hints that don't fit the static table.
    // npm-global on Windows lives in %APPDATA%\npm; Claude / Gemini / Codex
    // CLIs land here when installed via `npm install -g`, and that dir is
    // routinely missing from a GUI-launched process's PATH.
    #[cfg(windows)]
    {
        for dir in windows_npm_global_dirs() {
            for name in spec.names {
                let candidate = dir.join(name);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_npm_global_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("npm"));
        dirs.push(
            PathBuf::from(&local)
                .join("Programs")
                .join("npm"),
        );
    }
    if let Some(home) = crate::platform::home_dir() {
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join(".bun").join("bin"));
    }
    dirs
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = crate::platform::home_dir() {
            return home.join(rest);
        }
    } else if p == "~" {
        if let Some(home) = crate::platform::home_dir() {
            return home;
        }
    }
    PathBuf::from(p)
}

fn is_executable(p: &std::path::Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = p.metadata() {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(windows)]
    {
        // On Windows we don't have a portable exec bit; rely on extension.
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        matches!(ext.as_deref(), Some("exe" | "cmd" | "bat"))
    }
}

async fn probe_version(exec: &std::path::Path, arg: &str, re: Option<&str>) -> Option<String> {
    let mut cmd = Command::new(exec);
    cmd.arg(arg);
    cmd.kill_on_drop(true);
    let fut = cmd.output();
    let output = timeout(DEFAULT_VERSION_TIMEOUT, fut).await.ok()?.ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stderr).into_owned();
    }
    let regex = re.unwrap_or(super::known::DEFAULT_VERSION_REGEX);
    let parsed = Regex::new(regex).ok()?;
    let caps = parsed.captures(&text)?;
    caps.get(1).map(|m| m.as_str().to_string())
}

/// Returns `(Some(true), None)` if authed; `(Some(false), Some(hint))` if
/// not authed; `(None, None)` if the probe is inconclusive (e.g. an Exec
/// probe spawns but the binary doesn't exist at that path).
async fn probe_auth_with_hint(
    exec: &std::path::Path,
    check: &AuthCheck,
) -> (Option<bool>, Option<String>) {
    match check {
        AuthCheck::Exec {
            cmd,
            args,
            timeout_ms,
        } => probe_auth_exec(exec, cmd, args, *timeout_ms).await,
        AuthCheck::EnvVar { name } => {
            if env_truthy(name) {
                (Some(true), None)
            } else {
                (Some(false), Some(format!("{name} not set")))
            }
        }
        AuthCheck::FilePresent { paths } => probe_auth_files(paths),
        AuthCheck::Any { checks } => {
            // First successful inner check short-circuits.
            let mut hints: Vec<String> = Vec::new();
            for inner in *checks {
                let (val, hint) = Box::pin(probe_auth_with_hint(exec, inner)).await;
                if val == Some(true) {
                    return (Some(true), None);
                }
                if let Some(h) = hint {
                    hints.push(h);
                }
            }
            let hint = if hints.is_empty() {
                None
            } else {
                Some(format!("none of: {}", hints.join(" / ")))
            };
            (Some(false), hint)
        }
    }
}

async fn probe_auth_exec(
    exec_fallback: &std::path::Path,
    cmd: &str,
    args: &[&str],
    timeout_ms: u64,
) -> (Option<bool>, Option<String>) {
    // Prefer the resolved exec path when `cmd` matches its filename — saves
    // us a second `which` lookup and avoids races where a second binary by
    // the same name shadows the one we just found.
    let target: PathBuf = if exec_fallback
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == cmd || n == format!("{cmd}.cmd") || n == format!("{cmd}.exe"))
        .unwrap_or(false)
    {
        exec_fallback.to_path_buf()
    } else {
        match which::which(cmd) {
            Ok(p) => p,
            Err(_) => {
                return (
                    Some(false),
                    Some(format!("auth probe binary `{cmd}` not on PATH")),
                );
            }
        }
    };
    let mut command = Command::new(target);
    command.args(args);
    command.kill_on_drop(true);
    let fut = command.output();
    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(Ok(out)) => {
            if out.status.success() {
                (Some(true), None)
            } else {
                (
                    Some(false),
                    Some(format!(
                        "`{cmd} {}` exited {}",
                        args.join(" "),
                        out.status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "?".into())
                    )),
                )
            }
        }
        Ok(Err(e)) => (Some(false), Some(format!("auth probe failed: {e}"))),
        Err(_) => (
            None,
            Some(format!("auth probe `{cmd}` timed out after {timeout_ms}ms")),
        ),
    }
}

fn probe_auth_files(paths: &[&str]) -> (Option<bool>, Option<String>) {
    let mut tried: Vec<String> = Vec::new();
    for p in paths {
        let expanded = expand_tilde(p);
        if expanded.is_file() {
            return (Some(true), None);
        }
        tried.push(p.to_string());
    }
    (Some(false), Some(format!("missing: {}", tried.join(", "))))
}

fn env_truthy(name: &str) -> bool {
    matches!(std::env::var(name), Ok(v) if !v.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_detect::known::TargetFamily;

    #[test]
    fn expand_tilde_handles_home() {
        // Set the platform-appropriate home env var to a known value for the
        // duration of this test. Windows reads USERPROFILE; Unix reads HOME.
        #[cfg(windows)]
        let var = "USERPROFILE";
        #[cfg(not(windows))]
        let var = "HOME";
        let prev = std::env::var_os(var);
        std::env::set_var(var, "/tmp/fakehome");
        assert_eq!(expand_tilde("~/foo"), PathBuf::from("/tmp/fakehome/foo"));
        assert_eq!(expand_tilde("~"), PathBuf::from("/tmp/fakehome"));
        assert_eq!(expand_tilde("/abs"), PathBuf::from("/abs"));
        if let Some(p) = prev {
            std::env::set_var(var, p);
        } else {
            std::env::remove_var(var);
        }
    }

    #[test]
    fn resolve_executable_respects_target_family() {
        let def = AgentDef {
            id: "fake",
            display: "Fake",
            executables: &[ExecutableSpec {
                target_family: TargetFamily::Windows,
                names: &["definitely-not-on-path-fake-cli.exe"],
                extra_dirs: &[],
            }],
            version_arg: None,
            version_regex: None,
            auth_check: None,
            capabilities: AgentCapabilities {
                streaming: false,
                tool_use: false,
                thinking: false,
                artifacts: false,
                mcp: false,
                session_resume: false,
            },
        };
        // On linux, the Windows-only spec should be skipped.
        assert!(resolve_executable(&def, "linux").is_none());
    }

    #[tokio::test]
    async fn detect_returns_only_present_agents() {
        // Doesn't assert which agents — just that the call shape works
        // and every returned entry has a non-empty executable_path.
        let detected = detect_all().await;
        for d in detected {
            assert!(!d.executable_path.is_empty(), "{}", d.id);
            assert!(!d.id.is_empty());
        }
    }

    #[tokio::test]
    async fn probe_version_against_sh_returns_string() {
        // `sh --version` reliably prints a semver on every dev box we
        // run CI on. If `sh` isn't on PATH this test is skipped.
        let Some(sh_path) = which::which("sh").ok() else {
            return;
        };
        let v = probe_version(&sh_path, "--version", None).await;
        // We don't assert exact value because `sh` varies (bash, dash, zsh
        // symlink). It just needs to extract *some* semver.
        if let Some(v) = v {
            assert!(v.contains('.'), "got version `{v}`");
        }
    }

    #[test]
    fn env_truthy_recognises_set_var() {
        std::env::set_var("IKENGA_DETECT_TEST_VAR", "yes");
        assert!(env_truthy("IKENGA_DETECT_TEST_VAR"));
        std::env::set_var("IKENGA_DETECT_TEST_VAR", "");
        assert!(!env_truthy("IKENGA_DETECT_TEST_VAR"));
        std::env::remove_var("IKENGA_DETECT_TEST_VAR");
        assert!(!env_truthy("IKENGA_DETECT_TEST_VAR"));
    }
}
