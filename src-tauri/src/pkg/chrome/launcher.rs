//! Launch the user's installed Chrome in Managed mode + attach over CDP.
//!
//! Managed mode (per `plans/chrome-pkg/`): the *shell* owns the Chrome OS
//! process. We spawn the detected Chrome with a dedicated `--user-data-dir`
//! (never the user's real profile) and a `--remote-debugging-port`, wait for the
//! CDP endpoint to come up, resolve its `webSocketDebuggerUrl`, then attach with
//! [`chromiumoxide::Browser::connect`].
//!
//! We deliberately use `Browser::connect` (attach-to-running) rather than
//! `Browser::launch` (DEC-A in `06-cdp-engine-decisions.md`): the shell manages
//! the OS process itself so the lifecycle WP (WP-04) can reconcile it across
//! shell restarts (reattach if alive, clear a stale `SingletonLock` if dead).
//! chromiumoxide's launcher would own the child and hide it from that reconcile.
//!
//! This mirrors the proven spike-S1 recipe (`spikes/s1-login-feasibility.sh`)
//! on this exact box (Chrome 149): the same flags, the same `:<port>/json/version`
//! poll, the same `webSocketDebuggerUrl` resolution.
//!
//! The returned [`ManagedChrome`] holds the connected `Browser`, the child
//! process, the CDP port, and the profile dir. Later WPs build snapshot/action
//! surfaces on top of `browser`. Dropping the handle does NOT kill Chrome (that
//! is WP-04's lifecycle concern) — the `child` is exposed so the owner decides.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chromiumoxide::Browser;
use futures_util::StreamExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use super::detect::{detect_chrome, ChromeInstall};

/// How long to wait for the CDP HTTP endpoint to start serving after spawn.
const CDP_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Poll cadence while waiting for the CDP endpoint (mirrors spike S1's 0.5s).
const CDP_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// A launched + CDP-attached Managed Chrome.
///
/// Owns the process and the chromiumoxide `Browser`. The `_handler_task` drives
/// chromiumoxide's connection `Handler` stream for the lifetime of the
/// connection; aborting it (on drop) tears the CDP message pump down but leaves
/// the OS process running for the lifecycle layer to reconcile.
pub struct ManagedChrome {
    /// The connected chromiumoxide browser. Snapshot/action WPs drive this.
    pub browser: Browser,
    /// The Chrome OS child process. The lifecycle WP owns kill/reconcile; we
    /// surface it rather than detaching so a caller can reap deliberately.
    pub child: Child,
    /// The `--remote-debugging-port` Chrome is serving CDP on.
    pub port: u16,
    /// The dedicated `--user-data-dir` (never the user's real profile).
    pub profile_dir: PathBuf,
    /// The resolved `webSocketDebuggerUrl` we attached to (handy for the
    /// lifecycle WP's reattach path).
    pub ws_url: String,
    /// The detected Chrome install we launched.
    pub install: ChromeInstall,
    /// Drives chromiumoxide's `Handler` stream. Held so it isn't dropped (which
    /// would stop the CDP message pump). Aborted on `ManagedChrome` drop.
    _handler_task: JoinHandle<()>,
}

impl Drop for ManagedChrome {
    fn drop(&mut self) {
        // Stop the CDP pump. We do NOT kill `child` here — process lifecycle is
        // WP-04's job (reconcile-on-boot, conservative respawn). Dropping the
        // handle just severs our CDP attachment.
        self._handler_task.abort();
    }
}

/// Options for a Managed-Chrome launch.
pub struct LaunchOptions {
    /// Managed-profile name (resolved to a dedicated `--user-data-dir` via the
    /// WP-03 mock resolver below). Distinct names get distinct profiles.
    pub profile_name: String,
    /// Fixed CDP port, or `None` to let the OS pick a free one.
    pub port: Option<u16>,
    /// Extra flags appended after the managed defaults (e.g. `--headless=new`,
    /// initial URLs). Empty for the default interactive launch.
    pub extra_args: Vec<String>,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            profile_name: "default".to_string(),
            port: None,
            extra_args: Vec::new(),
        }
    }
}

/// Detect Chrome, launch it Managed, and attach over CDP. See module docs.
pub async fn launch_managed(opts: LaunchOptions) -> Result<ManagedChrome> {
    let install = detect_chrome().context("detect installed Chrome")?;

    let profile_dir =
        managed_profile_dir(&opts.profile_name).context("resolve managed profile dir")?;
    std::fs::create_dir_all(&profile_dir)
        .with_context(|| format!("create profile dir {}", profile_dir.display()))?;

    // Pick the CDP port. `--remote-debugging-port=0` makes Chrome bind a free
    // port and write the chosen one to `<user-data-dir>/DevToolsActivePort`;
    // we read it back after the endpoint comes up.
    let requested_port = opts.port.unwrap_or(0);

    // ── Spawn Chrome (mirrors spike S1) ──────────────────────────────────────
    let mut cmd = Command::new(&install.path);
    cmd.arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg(format!("--remote-debugging-port={requested_port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // Localhost-only debug surface; Chrome 136+ requires a non-default
        // user-data-dir for the port to bind at all (S1 gate-2 proved this on
        // a dedicated dir). We pass the dedicated dir above, so this is fine.
        .args(&opts.extra_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false); // lifecycle WP owns the kill decision

    let child = cmd
        .spawn()
        .with_context(|| format!("spawn Chrome at {}", install.path.display()))?;

    // ── Resolve the actual CDP port + wait for the endpoint ──────────────────
    let port = resolve_port(requested_port, &profile_dir).await?;
    let version_json = wait_for_cdp(port).await?;
    let ws_url = version_json
        .web_socket_debugger_url
        .ok_or_else(|| anyhow!("CDP /json/version had no webSocketDebuggerUrl"))?;

    // ── Attach over CDP ──────────────────────────────────────────────────────
    let (browser, mut handler) = Browser::connect(&ws_url)
        .await
        .with_context(|| format!("chromiumoxide Browser::connect({ws_url})"))?;

    // chromiumoxide's `Handler` is a Stream that must be polled for the whole
    // life of the connection — it pumps CDP messages between us and Chrome.
    // Spawn it on a tokio task; it ends when the connection closes (or we abort
    // it on drop). Errors are logged, not propagated (the connection is gone).
    let handler_task = tokio::spawn(async move {
        while let Some(ev) = handler.next().await {
            if let Err(e) = ev {
                tracing::warn!("[chrome] CDP handler error: {e}");
                break;
            }
        }
        tracing::info!("[chrome] CDP handler stream ended");
    });

    tracing::info!(
        "[chrome] managed launch: {} ({}) port={port} profile={} ws={ws_url}",
        install.path.display(),
        install.version,
        profile_dir.display(),
    );

    Ok(ManagedChrome {
        browser,
        child,
        port,
        profile_dir,
        ws_url,
        install,
        _handler_task: handler_task,
    })
}

/// Subset of `http://127.0.0.1:<port>/json/version` we care about.
#[derive(Debug, serde::Deserialize)]
struct CdpVersion {
    #[serde(rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: Option<String>,
}

/// Resolve the effective CDP port. If a fixed port was requested we trust it;
/// if `0` (OS-picked), read `<user-data-dir>/DevToolsActivePort`, whose first
/// line is the chosen port (Chrome writes it once the listener is up).
async fn resolve_port(requested: u16, profile_dir: &PathBuf) -> Result<u16> {
    if requested != 0 {
        return Ok(requested);
    }
    let active_port_file = profile_dir.join("DevToolsActivePort");
    let deadline = tokio::time::Instant::now() + CDP_READY_TIMEOUT;
    loop {
        if let Ok(contents) = tokio::fs::read_to_string(&active_port_file).await {
            if let Some(first) = contents.lines().next() {
                if let Ok(p) = first.trim().parse::<u16>() {
                    return Ok(p);
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "Chrome never wrote a usable DevToolsActivePort in {}",
                active_port_file.display()
            ));
        }
        tokio::time::sleep(CDP_POLL_INTERVAL).await;
    }
}

/// Poll `http://127.0.0.1:<port>/json/version` until it serves (the CDP HTTP
/// endpoint is up) or we time out. Returns the parsed version payload.
async fn wait_for_cdp(port: u16) -> Result<CdpVersion> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + CDP_READY_TIMEOUT;
    // Held across retries so the timeout error can report the most recent
    // failure cause. The final write before a successful return is naturally
    // unread — that's the retry pattern, not a bug.
    #[allow(unused_assignments)]
    let mut last_err: Option<String> = None;
    loop {
        // Parse from the response body text rather than `resp.json()` — the
        // shell's reqwest is built without the `json` feature (it's shared, so
        // we don't widen its feature set just for this), and serde_json is a
        // direct dep anyway.
        match client.get(&url).send().await {
            Ok(resp) => match resp.text().await {
                Ok(body) => match serde_json::from_str::<CdpVersion>(&body) {
                    Ok(v) => return Ok(v),
                    Err(e) => last_err = Some(format!("decode /json/version: {e}")),
                },
                Err(e) => last_err = Some(format!("read /json/version body: {e}")),
            },
            Err(e) => last_err = Some(format!("GET {url}: {e}")),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "CDP endpoint never came up on :{port} within {:?} ({})",
                CDP_READY_TIMEOUT,
                last_err.unwrap_or_else(|| "no response".to_string())
            ));
        }
        tokio::time::sleep(CDP_POLL_INTERVAL).await;
    }
}

// ── Mock contract 1: profile-dir resolver (owned by WP-03) ───────────────────
//
// WP-02 codes against this frozen signature and stubs it with a temp dir. WP-03
// replaces the body with the real `app_data_dir`-rooted resolver (one-line swap
// at the call site if the signature holds).
//
// TODO(WP-03): replace stub with the real resolver (app_data_dir-rooted,
// SQLite-tracked managed profiles).
fn managed_profile_dir(profile_name: &str) -> anyhow::Result<std::path::PathBuf> {
    Ok(std::env::temp_dir().join(format!("ikenga-managed-{profile_name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_profile_dir_is_namespaced_under_temp() {
        let dir = managed_profile_dir("acme").unwrap();
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s == "ikenga-managed-acme")
            .unwrap_or(false));
    }

    #[test]
    fn launch_options_default_is_os_picked_port() {
        let o = LaunchOptions::default();
        assert_eq!(o.port, None);
        assert_eq!(o.profile_name, "default");
        assert!(o.extra_args.is_empty());
    }
}
