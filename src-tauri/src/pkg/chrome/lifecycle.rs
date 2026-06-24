//! Managed-Chrome lifecycle / supervisor — reconcile-on-boot (WP-04, closes R8).
//!
//! Managed Chrome is a *shell-owned* OS process (DEC-B in
//! `plans/chrome-pkg/06-cdp-engine-decisions.md`): the shell spawns the user's
//! installed Chrome on a dedicated `--user-data-dir` + CDP port (WP-02's
//! [`launch_managed`]) and must reconcile that process across its own restarts.
//! Left undefined, a shell restart orphans Chrome and leaves a stale
//! `SingletonLock` in the profile dir that blocks the next launch — that is R8.
//!
//! This module is the supervised-runtime sibling of the pkg MCP/sidecar
//! supervisor (`crate::pkg::lifecycle::SidecarSupervisor`). We deliberately
//! mirror its *conservative respawn* stance (no auto-respawn by default — the
//! agent-scheduler respawn-cascade lesson) rather than its full state machine:
//! Chrome is one process per profile, not a multiplexed JSON-RPC child.
//!
//! ## What it does
//!
//! 1. **On launch** ([`record_launch`]) write a small endpoint file
//!    `<profile_dir>/.ikenga-managed.json` = `{ pid, port, ws_url }`. This is
//!    the breadcrumb a later boot reads to find the prior owner.
//! 2. **On boot** ([`reconcile_on_boot`]) — idempotent:
//!    - prior owner **alive** (pid live *and* CDP `/json/version` answers) →
//!      `chromiumoxide::Browser::connect(ws_url)` reattach, **no relaunch**;
//!    - **dead** but a stale `SingletonLock` is present in the dir → remove the
//!      lock, then [`launch_managed`];
//!    - **nothing** (no record / no lock) → [`launch_managed`].
//! 3. **Process state** ([`ChromeState`]) — `Launching/Alive/Crashed/Detached/
//!    Dead` — the field `browser_list` reads later (WP-06/07). Crash =>
//!    `Crashed`, **no auto-respawn**; user-closes-window => CDP disconnect =>
//!    `Detached`/`Dead`. This module defines the enum + the transition helpers;
//!    wiring it into `browser_list` is WP-06/07's concern.
//!
//! The reconcile *decision* is factored into a pure function
//! ([`decide_reconcile`]) that takes injected liveness probes, so the
//! alive/dead/stale-lock branching is unit-tested without spawning Chrome.
//! [`reconcile_on_boot`] layers the real probes (pid + CDP) + the real launch
//! on top.

#![allow(dead_code)] // unconsumed until WP-06/07 wire browser_list + routing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chromiumoxide::Browser;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::launcher::{launch_managed, LaunchOptions, ManagedChrome};

/// Endpoint/PID breadcrumb file, written under the managed `--user-data-dir`.
/// Leading dot keeps it out of casual `ls` and alongside Chrome's own
/// dot-prefixed state. Lives *inside* the profile dir so it travels with the
/// profile and a different profile can never read another's record.
pub const RECORD_FILENAME: &str = ".ikenga-managed.json";

/// Chrome's own single-instance guard inside a `--user-data-dir`. When Chrome
/// dies uncleanly (e.g. the shell was killed mid-session) this is left behind
/// and blocks the next launch on that dir until removed. On Linux it is a
/// symlink; removing it is the documented stale-lock recovery.
pub const SINGLETON_LOCK: &str = "SingletonLock";

/// How long the real CDP liveness probe waits for `/json/version` to answer
/// before declaring the prior owner dead. Short: a *live* Chrome answers in
/// single-digit ms; we don't want boot to stall on a corpse.
const CDP_PROBE_TIMEOUT: Duration = Duration::from_millis(750);

// ── Endpoint record ──────────────────────────────────────────────────────────

/// The breadcrumb written on launch and read on the next boot. Just enough to
/// (a) probe the prior process for liveness and (b) reattach over CDP without
/// re-resolving the port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedRecord {
    /// OS pid of the spawned Chrome (the `child.id()` at launch time).
    pub pid: u32,
    /// The `--remote-debugging-port` Chrome served CDP on.
    pub port: u16,
    /// The resolved `webSocketDebuggerUrl` we attached to — reused verbatim by
    /// the reattach path so we never have to re-resolve it.
    pub ws_url: String,
}

/// Absolute path to the record file for a given profile dir.
pub fn record_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(RECORD_FILENAME)
}

/// Absolute path to Chrome's `SingletonLock` for a given profile dir.
pub fn singleton_lock_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(SINGLETON_LOCK)
}

/// Write/overwrite the endpoint record under `profile_dir`. Called by the
/// launch path immediately after a successful `launch_managed`.
pub fn write_record(profile_dir: &Path, record: &ManagedRecord) -> Result<()> {
    let path = record_path(profile_dir);
    let json = serde_json::to_string_pretty(record).context("serialize ManagedRecord")?;
    std::fs::write(&path, json).with_context(|| format!("write managed record {}", path.display()))?;
    Ok(())
}

/// Read the endpoint record from `profile_dir`, if present + parseable.
///
/// A missing file returns `Ok(None)` (the common first-launch case). A present
/// but corrupt/partial file also returns `Ok(None)` — we treat an unreadable
/// breadcrumb as "no prior owner" and fall through to a fresh launch rather
/// than erroring boot. (A truncated write from a crash mid-flush is exactly the
/// case we want to recover from, not fail on.)
pub fn read_record(profile_dir: &Path) -> Result<Option<ManagedRecord>> {
    let path = record_path(profile_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(anyhow!("read managed record {}: {e}", path.display())),
    };
    match serde_json::from_str::<ManagedRecord>(&raw) {
        Ok(r) => Ok(Some(r)),
        Err(e) => {
            tracing::warn!(
                "[chrome.lifecycle] managed record {} unparseable ({e}); treating as no prior owner",
                path.display()
            );
            Ok(None)
        }
    }
}

/// Remove the endpoint record (best-effort). Called when we determine the
/// recorded owner is dead and we're about to relaunch — the launch path writes
/// a fresh one. Missing file is success.
pub fn remove_record(profile_dir: &Path) -> Result<()> {
    let path = record_path(profile_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow!("remove managed record {}: {e}", path.display())),
    }
}

/// Remove a stale `SingletonLock` from `profile_dir`, if present. Returns
/// `Ok(true)` if a lock was actually removed, `Ok(false)` if there was none.
///
/// Uses `remove_file`, which on Unix unlinks the *symlink itself* (Chrome's
/// lock is a symlink to `<host>-<pid>`), not its dangling target — exactly what
/// we want. Only ever called once we've already decided the prior owner is
/// dead, so we are not racing a live Chrome for the lock.
pub fn clear_singleton_lock(profile_dir: &Path) -> Result<bool> {
    let path = singleton_lock_path(profile_dir);
    // symlink_metadata: don't follow the link (the target may not exist).
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            std::fs::remove_file(&path)
                .with_context(|| format!("remove stale SingletonLock {}", path.display()))?;
            tracing::info!("[chrome.lifecycle] cleared stale SingletonLock {}", path.display());
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(anyhow!("stat SingletonLock {}: {e}", path.display())),
    }
}

// ── Process state ────────────────────────────────────────────────────────────

/// Lifecycle state of a Managed Chrome, surfaced into `browser_list` by later
/// WPs. `serde` lowercases the variant names to match the wire convention of
/// the existing browser-session states (`engine`, `surface_kind`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChromeState {
    /// We've spawned Chrome and are waiting for the CDP endpoint to come up /
    /// for `Browser::connect` to complete.
    Launching,
    /// Connected over CDP and the process is live — the normal running state.
    Alive,
    /// The process exited unexpectedly while we still held the connection.
    /// **No auto-respawn** — a Restart affordance is offered instead (DEC-B,
    /// conservative respawn). Distinct from `Detached`, which is the *expected*
    /// user-initiated close.
    Crashed,
    /// The CDP connection dropped but we have not confirmed the OS process is
    /// gone (e.g. the user closed the last window; Chrome may be tearing down).
    /// A transient state on the way to `Dead`.
    Detached,
    /// The process is confirmed gone. Terminal; the pane handle is stale and
    /// the record should be cleared before any relaunch.
    Dead,
}

impl ChromeState {
    pub fn label(self) -> &'static str {
        match self {
            ChromeState::Launching => "launching",
            ChromeState::Alive => "alive",
            ChromeState::Crashed => "crashed",
            ChromeState::Detached => "detached",
            ChromeState::Dead => "dead",
        }
    }

    /// Whether this state means "there is a usable live process we are attached
    /// to". Only `Alive`.
    pub fn is_live(self) -> bool {
        matches!(self, ChromeState::Alive)
    }
}

// ── Reconcile decision (pure, injectable probes) ─────────────────────────────

/// What [`reconcile_on_boot`] should do, derived purely from the record + the
/// liveness probes. Factored out so every branch is unit-tested without
/// spawning Chrome or touching the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileDecision {
    /// Prior owner is alive — reattach over CDP at this ws url. No relaunch.
    Reattach { ws_url: String, port: u16 },
    /// Prior owner is dead but a `SingletonLock` (or stale record) is present —
    /// clear the lock + record, then launch fresh.
    ClearLockAndLaunch,
    /// No usable prior owner — launch fresh. (No record at all, or a record but
    /// no lock and a dead process: still just launch, nothing to clear beyond a
    /// best-effort record sweep.)
    Launch,
}

/// Pure reconcile decision. `record` is the parsed breadcrumb (if any);
/// `pid_alive` probes whether the recorded pid is a live process; `cdp_answers`
/// probes whether CDP `/json/version` answers on the recorded port;
/// `lock_present` reports whether a `SingletonLock` exists in the dir.
///
/// Rules (DEC-B):
/// - record present **and** pid alive **and** CDP answers → `Reattach`.
/// - record present but the owner is **not** fully alive: if a lock is present
///   → `ClearLockAndLaunch`; otherwise → `Launch` (still sweep the stale
///   record on the launch path).
/// - no record: if a lock is somehow present → `ClearLockAndLaunch` (a lock
///   with no record is a stale corpse from a non-managed or pre-record run);
///   otherwise → `Launch`.
///
/// We require **both** pid liveness and a CDP answer for `Reattach`: a pid can
/// be alive but the CDP listener gone (Chrome shutting down, or pid reused by
/// an unrelated process), in which case reattaching would hang/fail — safer to
/// relaunch.
pub fn decide_reconcile(
    record: Option<&ManagedRecord>,
    pid_alive: impl Fn(u32) -> bool,
    cdp_answers: impl Fn(u16) -> bool,
    lock_present: bool,
) -> ReconcileDecision {
    match record {
        Some(r) => {
            if pid_alive(r.pid) && cdp_answers(r.port) {
                ReconcileDecision::Reattach {
                    ws_url: r.ws_url.clone(),
                    port: r.port,
                }
            } else if lock_present {
                ReconcileDecision::ClearLockAndLaunch
            } else {
                ReconcileDecision::Launch
            }
        }
        None => {
            if lock_present {
                ReconcileDecision::ClearLockAndLaunch
            } else {
                ReconcileDecision::Launch
            }
        }
    }
}

// ── Reconcile outcome ────────────────────────────────────────────────────────

/// The product of [`reconcile_on_boot`]: either a freshly-launched Chrome we
/// own outright, or a reattached connection to a process that predates this
/// shell run.
///
/// `Reattached` deliberately carries **no `tokio::process::Child`** — the OS
/// process was spawned by a *prior* shell run, so this run has no `Child`
/// handle for it (you can't adopt another run's child). It still holds the
/// connected `Browser` + the handler-pump task, so the CDP surface is
/// identical; the difference is only in who can `kill()` the process (nobody,
/// directly — a reattached Chrome is shut down via CDP `Browser.close` by the
/// action layer, or left to the user).
pub enum ReconcileOutcome {
    /// Reattached to a live prior owner. No owned `Child`.
    Reattached {
        browser: Browser,
        port: u16,
        ws_url: String,
        profile_dir: PathBuf,
        /// Drives chromiumoxide's `Handler` stream for the reattached
        /// connection (same role as `ManagedChrome`'s handler task). Aborted
        /// when this outcome is dropped.
        handler_task: JoinHandle<()>,
    },
    /// Launched a fresh Chrome that this run owns (incl. the `Child`).
    Launched(ManagedChrome),
}

impl ReconcileOutcome {
    /// The connected `chromiumoxide::Browser`, regardless of variant — the
    /// snapshot/action WPs drive this and don't care how we got here.
    pub fn browser(&self) -> &Browser {
        match self {
            ReconcileOutcome::Reattached { browser, .. } => browser,
            ReconcileOutcome::Launched(m) => &m.browser,
        }
    }

    pub fn port(&self) -> u16 {
        match self {
            ReconcileOutcome::Reattached { port, .. } => *port,
            ReconcileOutcome::Launched(m) => m.port,
        }
    }

    pub fn ws_url(&self) -> &str {
        match self {
            ReconcileOutcome::Reattached { ws_url, .. } => ws_url,
            ReconcileOutcome::Launched(m) => &m.ws_url,
        }
    }

    pub fn profile_dir(&self) -> &Path {
        match self {
            ReconcileOutcome::Reattached { profile_dir, .. } => profile_dir,
            ReconcileOutcome::Launched(m) => &m.profile_dir,
        }
    }

    /// True when we reattached to a prior owner (no owned `Child`).
    pub fn is_reattached(&self) -> bool {
        matches!(self, ReconcileOutcome::Reattached { .. })
    }
}

impl Drop for ReconcileOutcome {
    fn drop(&mut self) {
        // Mirror ManagedChrome::drop for the reattached arm: stop the CDP pump,
        // don't kill the (foreign) process. The Launched arm's ManagedChrome
        // has its own Drop that aborts its handler task.
        if let ReconcileOutcome::Reattached { handler_task, .. } = self {
            handler_task.abort();
        }
    }
}

// ── Real reconcile entry point ───────────────────────────────────────────────

/// Idempotent reconcile-on-boot for a managed profile dir. See module docs.
///
/// Reads the breadcrumb, runs [`decide_reconcile`] with the real pid + CDP
/// probes, and either reattaches (`Browser::connect`) or launches fresh
/// (`launch_managed`, after clearing any stale lock + record). On a fresh
/// launch it (re)writes the breadcrumb so the *next* boot can reconcile this
/// run.
///
/// `profile_name` is the WP-03 managed-profile name; it must resolve (via
/// `launch_managed`'s use of `profile::managed_profile_dir`) to `profile_dir`.
/// We take both so the reconcile reads the same dir the launch will write to —
/// the caller resolves the dir once (WP-03) and threads it here.
pub async fn reconcile_on_boot(profile_name: &str, profile_dir: &Path) -> Result<ReconcileOutcome> {
    let record = read_record(profile_dir)?;
    let lock_present = singleton_lock_path(profile_dir).exists()
        // `exists()` follows symlinks → a dangling lock symlink reads false.
        // Fall back to symlink_metadata so a dangling lock still counts.
        || std::fs::symlink_metadata(singleton_lock_path(profile_dir)).is_ok();

    // Probe pid first (sync, cheap); only probe CDP (async, ~ms when alive,
    // up to CDP_PROBE_TIMEOUT when dead) if the pid is alive — preserves the
    // short-circuit decide_reconcile expresses, without blocking the reactor.
    let pid_alive = record.as_ref().map(|r| pid_is_alive(r.pid)).unwrap_or(false);
    let cdp_ok = match (pid_alive, record.as_ref()) {
        (true, Some(r)) => cdp_answers(r.port).await,
        _ => false,
    };

    let decision = decide_reconcile(
        record.as_ref(),
        |_| pid_alive,
        |_| cdp_ok,
        lock_present,
    );

    match decision {
        ReconcileDecision::Reattach { ws_url, port } => {
            tracing::info!(
                "[chrome.lifecycle] prior owner alive on :{port}; reattaching ({ws_url})"
            );
            let (browser, mut handler) = Browser::connect(&ws_url)
                .await
                .with_context(|| format!("reattach Browser::connect({ws_url})"))?;
            let handler_task = tokio::spawn(async move {
                while let Some(ev) = handler.next().await {
                    if let Err(e) = ev {
                        tracing::warn!("[chrome.lifecycle] reattach CDP handler error: {e}");
                        break;
                    }
                }
                tracing::info!("[chrome.lifecycle] reattach CDP handler stream ended");
            });
            Ok(ReconcileOutcome::Reattached {
                browser,
                port,
                ws_url,
                profile_dir: profile_dir.to_path_buf(),
                handler_task,
            })
        }
        ReconcileDecision::ClearLockAndLaunch => {
            // Dead owner + stale lock: clear the lock + the stale record, then
            // launch. clear_singleton_lock is safe here — we only reach this
            // arm once the owner is confirmed not-fully-alive.
            clear_singleton_lock(profile_dir)?;
            remove_record(profile_dir).ok();
            launch_and_record(profile_name, profile_dir).await
        }
        ReconcileDecision::Launch => {
            // No usable prior owner. Sweep any stale record best-effort (no
            // lock to clear), then launch.
            remove_record(profile_dir).ok();
            launch_and_record(profile_name, profile_dir).await
        }
    }
}

/// Launch fresh via WP-02 and write the breadcrumb for the next boot.
async fn launch_and_record(profile_name: &str, profile_dir: &Path) -> Result<ReconcileOutcome> {
    let managed = launch_managed(LaunchOptions {
        profile_name: profile_name.to_string(),
        ..Default::default()
    })
    .await
    .context("launch_managed during reconcile")?;

    // Defensive: the launcher resolves the dir from the same profile name, so
    // it should equal `profile_dir`. If a caller threads a mismatched dir we
    // still record under the dir Chrome actually used (managed.profile_dir),
    // so the next boot reads the right breadcrumb.
    let record = ManagedRecord {
        pid: managed.child.id().unwrap_or(0),
        port: managed.port,
        ws_url: managed.ws_url.clone(),
    };
    if let Err(e) = write_record(&managed.profile_dir, &record) {
        // A missing breadcrumb only degrades the *next* boot's reconcile to a
        // fresh launch; it's not fatal to this run.
        tracing::warn!("[chrome.lifecycle] failed to write managed record: {e:#}");
    }
    let _ = profile_dir; // resolved-by-name; kept in the signature for clarity.
    Ok(ReconcileOutcome::Launched(managed))
}

/// Convenience for the launch path outside reconcile (WP-06/07): record an
/// already-launched Chrome's endpoint under its profile dir.
pub fn record_launch(managed: &ManagedChrome) -> Result<()> {
    let record = ManagedRecord {
        pid: managed.child.id().unwrap_or(0),
        port: managed.port,
        ws_url: managed.ws_url.clone(),
    };
    write_record(&managed.profile_dir, &record)
}

// ── Real liveness probes ─────────────────────────────────────────────────────

/// Real pid-liveness probe. v1 is Linux/Chrome-149 only; the Linux path checks
/// `/proc/<pid>` existence — dependency-free (the `libc` crate is a macOS-only
/// target dep in this shell, so `kill(pid,0)` isn't available here), and it's
/// the same `/proc` approach `pty::foreground` uses. A pid of 0 (we failed to
/// read the child id at launch) is treated as not-alive so we never reattach to
/// a bogus record.
#[cfg(target_os = "linux")]
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Non-Linux fallback (not built for v1; Windows/macOS reconcile is Phase 3).
/// Conservatively reports the process as dead so reconcile relaunches rather
/// than reattaching to an unprobed process.
#[cfg(not(target_os = "linux"))]
fn pid_is_alive(_pid: u32) -> bool {
    false
}

/// Real CDP-liveness probe: does `http://127.0.0.1:<port>/json/version` answer
/// within [`CDP_PROBE_TIMEOUT`]? Synchronous (blocking) wrapper so it slots
/// into the `Fn(u16) -> bool` probe shape `decide_reconcile` expects without
/// making the decision function async.
///
/// Async because `reconcile_on_boot` already runs on the tokio runtime — no
/// scoped-thread / nested-runtime dance needed. Mirrors `launcher::wait_for_cdp`'s
/// async `reqwest::Client`. Any error (connection refused, timeout, non-2xx)
/// reads as "not answering" → dead.
async fn cdp_answers(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::new();
    matches!(
        tokio::time::timeout(CDP_PROBE_TIMEOUT, client.get(&url).send()).await,
        Ok(Ok(resp)) if resp.status().is_success()
    )
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> ManagedRecord {
        ManagedRecord {
            pid: 4242,
            port: 9333,
            ws_url: "ws://127.0.0.1:9333/devtools/browser/abc".to_string(),
        }
    }

    // ── record (de)serialize round-trip + on-disk I/O ────────────────────────

    #[test]
    fn record_json_roundtrips() {
        let r = rec();
        let json = serde_json::to_string(&r).unwrap();
        let back: ManagedRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn record_write_read_remove_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ikenga-lifecycle-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // No record yet.
        assert_eq!(read_record(&dir).unwrap(), None);
        // Write + read back.
        let r = rec();
        write_record(&dir, &r).unwrap();
        assert_eq!(read_record(&dir).unwrap(), Some(r));
        // Remove → gone.
        remove_record(&dir).unwrap();
        assert_eq!(read_record(&dir).unwrap(), None);
        // Remove again is a no-op (not an error).
        remove_record(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_record_reads_as_none() {
        let dir = std::env::temp_dir()
            .join(format!("ikenga-lifecycle-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(record_path(&dir), b"{ not json ]").unwrap();
        // Unparseable breadcrumb → treated as no prior owner, not an error.
        assert_eq!(read_record(&dir).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn record_path_is_under_profile_dir() {
        let dir = Path::new("/data/profiles/default");
        assert_eq!(record_path(dir), dir.join(RECORD_FILENAME));
        assert!(record_path(dir).starts_with(dir));
    }

    // ── stale-lock decision via injected alive/dead probes ───────────────────

    #[test]
    fn decide_reattach_when_alive_and_cdp_answers() {
        let r = rec();
        let d = decide_reconcile(Some(&r), |_| true, |_| true, /*lock*/ true);
        assert_eq!(
            d,
            ReconcileDecision::Reattach {
                ws_url: r.ws_url.clone(),
                port: r.port,
            }
        );
    }

    #[test]
    fn decide_clear_lock_when_dead_pid_but_lock_present() {
        let r = rec();
        // pid dead → not alive even though a lock lingers.
        let d = decide_reconcile(Some(&r), |_| false, |_| true, /*lock*/ true);
        assert_eq!(d, ReconcileDecision::ClearLockAndLaunch);
    }

    #[test]
    fn decide_clear_lock_when_pid_alive_but_cdp_silent_and_lock_present() {
        let r = rec();
        // pid alive but CDP gone (Chrome shutting down / pid reused) → not a
        // safe reattach; with a lock present we clear it and relaunch.
        let d = decide_reconcile(Some(&r), |_| true, |_| false, /*lock*/ true);
        assert_eq!(d, ReconcileDecision::ClearLockAndLaunch);
    }

    #[test]
    fn decide_launch_when_dead_and_no_lock() {
        let r = rec();
        let d = decide_reconcile(Some(&r), |_| false, |_| false, /*lock*/ false);
        assert_eq!(d, ReconcileDecision::Launch);
    }

    #[test]
    fn decide_launch_when_no_record_no_lock() {
        let d = decide_reconcile(None, |_| true, |_| true, /*lock*/ false);
        assert_eq!(d, ReconcileDecision::Launch);
    }

    #[test]
    fn decide_clear_lock_when_no_record_but_lock_present() {
        // A lock with no breadcrumb = a corpse from a non-managed/pre-record
        // run: clear it before launching.
        let d = decide_reconcile(None, |_| true, |_| true, /*lock*/ true);
        assert_eq!(d, ReconcileDecision::ClearLockAndLaunch);
    }

    #[test]
    fn pid_alive_probe_recognizes_self_and_rejects_zero() {
        // This process is obviously alive; pid 0 is never alive.
        #[cfg(unix)]
        {
            assert!(pid_is_alive(std::process::id()));
        }
        assert!(!pid_is_alive(0));
    }

    // ── ChromeState ──────────────────────────────────────────────────────────

    #[test]
    fn chrome_state_labels_and_liveness() {
        assert_eq!(ChromeState::Alive.label(), "alive");
        assert_eq!(ChromeState::Crashed.label(), "crashed");
        assert_eq!(ChromeState::Detached.label(), "detached");
        assert_eq!(ChromeState::Dead.label(), "dead");
        assert_eq!(ChromeState::Launching.label(), "launching");
        assert!(ChromeState::Alive.is_live());
        assert!(!ChromeState::Crashed.is_live());
        assert!(!ChromeState::Detached.is_live());
    }

    #[test]
    fn chrome_state_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ChromeState::Crashed).unwrap(),
            "\"crashed\""
        );
    }

    #[test]
    fn clear_singleton_lock_handles_missing() {
        let dir = std::env::temp_dir()
            .join(format!("ikenga-lifecycle-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // No lock → Ok(false).
        assert!(!clear_singleton_lock(&dir).unwrap());
        // Create a plain-file lock and clear it → Ok(true) then gone.
        std::fs::write(singleton_lock_path(&dir), b"host-1234").unwrap();
        assert!(clear_singleton_lock(&dir).unwrap());
        assert!(!singleton_lock_path(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
