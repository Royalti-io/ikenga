//! Sidecar supervisor for long-lived MCP servers.
//!
//! Decouples MCP-server lifetime from individual `tools/call` invocations.
//! Per-call mode (the historical path in `mcp_runtime::call_tool`) spawns +
//! reaps a child every call. That's correct for stateless test fixtures and
//! cheap node scripts, but wrong for sidecars that own session state — preview
//! servers, file watchers, render workers — all of which assume a single
//! process across many calls.
//!
//! A package opts into the supervised path by setting `mcp[].lifecycle =
//! "long-lived"` in its manifest. At install / boot-replay time, this
//! supervisor (registered as a kernel `Registry`) spawns the child once,
//! performs the MCP handshake, and keeps the child alive. `pkg_mcp_call`
//! dispatches through `call_tool` here, multiplexing requests over the
//! single child's stdin/stdout by JSON-RPC id.
//!
//! ## State machine
//!
//! ```text
//!                    register()
//!                       │
//!                       ▼
//!              ┌── Spawning ──┐ spawn ok
//!              │              ▼
//!              │           Running ──── child exits ───┐
//!              │ spawn err                              │
//!              ▼                                        ▼
//!         Crashed ◄────────────────── handshake fails  │
//!              │                                        │
//!              │ retries<3 within 60s window           │
//!              │ ─── sleep 1s, respawn ──┐              │
//!              └─────────────────────────┘              │
//!              │                                        │
//!              │ retries>=3                             │
//!              ▼                                        │
//!          Parked  ◄──────────────────────────────────┘ │
//!                                                         │
//!  Any state ── unregister() ── ShuttingDown ── (gone)    │
//! ```
//!
//! The 60s window slides from `first_crash_at`. If the child stays alive
//! for more than 60s after a successful respawn, the next crash starts a
//! fresh window — "ran fine for ages then died once" is not punished.
//!
//! ## Concurrency model
//!
//! One supervised child = one stdin writer task + one stdout read-loop +
//! a shared `pending: HashMap<id, oneshot::Sender<...>>`. Each `call_tool`
//! mints a new JSON-RPC id (per-child `AtomicU64` starting at 100, so the
//! handshake's fixed ids 1+2 never collide), inserts a oneshot receiver
//! into `pending`, writes the framed request, and awaits the receiver.
//! The read-loop dispatches responses by id; on stdout EOF it closes every
//! pending sender with "child exited" and signals the supervisor task via
//! a per-cycle oneshot channel to transition to `Crashed`.
//!
//! ## Why initialize-failure counts as a crash, not a fatal manifest error
//!
//! Initialize-handshake failures are sometimes transient (slow disk on first
//! boot, env race) and the retry budget is the right circuit-breaker.
//! Genuine manifest bugs surface within 3 retries → Parked, which is plenty
//! visible in `pkg_kernel_status`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::timeout;

use crate::pkg::manifest::{McpServer, Package};
use crate::pkg::registry::Registry;

/// Per-call wallclock cap for `tools/call` against a supervised child.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Cap on the initialize handshake. A child that can't `initialize` within
/// this window is treated as crashed (the retry budget kicks in).
const INIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Restart policy: at most this many crashes inside the sliding window
/// before transitioning to Parked.
const MAX_RETRIES: u32 = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const RESTART_DELAY: Duration = Duration::from_secs(1);

/// Operator-fixable failures (today: port-in-use) park into Blocked rather
/// than counting a strike. The supervisor re-spawns every BLOCKED_RETRY
/// indefinitely until the port frees up or the operator hits Restart.
const BLOCKED_RETRY: Duration = Duration::from_secs(10);

const PROTOCOL_VERSION: &str = "2025-06-18";
const CLIENT_NAME: &str = "ikenga-desktop";
const CLIENT_VERSION: &str = "0.1.0";

// ── Public types ─────────────────────────────────────────────────────────────

/// Snapshot for `pkg_kernel_status` — frozen view of one supervised pkg.
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub pkg_id: String,
    pub state: &'static str,
    pub pid: Option<u32>,
    pub uptime_s: Option<u64>,
    pub restarts: u32,
    pub last_crash_unix_ms: Option<i64>,
    pub last_err: Option<String>,
}

/// FE-visible lifecycle state. Collapsed view of the internal `State` enum:
/// the UI only needs to know booting / ready / error{reason}. Full enum is
/// still available via `pkg_kernel_status` for debugging.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LifecycleKind {
    Booting,
    Ready,
    Error { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvent {
    pub pkg_id: String,
    #[serde(flatten)]
    pub state: LifecycleKind,
}

/// Tauri event channel name for lifecycle broadcasts. One channel for the
/// whole app; subscribers filter by `pkg_id` payload.
pub const LIFECYCLE_EVENT: &str = "pkg://lifecycle";

#[derive(Default)]
pub struct SidecarSupervisor {
    /// pkg_id → supervised handle. Reads (call_tool, snapshot) take the read
    /// lock; register/unregister take the write lock briefly. Per-pkg
    /// supervisor tasks themselves do not hold this lock.
    children: RwLock<HashMap<String, Arc<SupervisedSidecar>>>,
    /// AppHandle for emitting lifecycle events. None in unit tests where no
    /// Tauri app is running — emit becomes a no-op.
    app: Option<AppHandle>,
    /// Phase 5 (projects-first-class): DB handle for resolving each
    /// supervised pkg's project context (own scope + active-project
    /// fallback) at spawn time, so `IKENGA_PROJECT_ID` + `IKENGA_PROJECT_ROOT`
    /// can be injected as env on the child. `None` in unit tests where no
    /// DB exists — env injection becomes a no-op.
    pa_db: Option<Arc<crate::commands::db::PaDb>>,
}

impl SidecarSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_app(app: AppHandle) -> Self {
        Self {
            children: RwLock::new(HashMap::new()),
            app: Some(app),
            pa_db: None,
        }
    }

    /// Builder-style hook for the Phase 5 project-context env injection.
    /// Called from `lib.rs::setup` once `PaDb` is constructed.
    pub fn with_db(mut self, db: Arc<crate::commands::db::PaDb>) -> Self {
        self.pa_db = Some(db);
        self
    }

    /// Look up a supervised pkg's handle. Returns None if the pkg is not
    /// installed under the supervised path.
    pub fn get(&self, pkg_id: &str) -> Option<Arc<SupervisedSidecar>> {
        self.children.read().ok()?.get(pkg_id).cloned()
    }

    /// Per-pkg status snapshots. Surfaced via `Registry::snapshot` into
    /// `pkg_kernel_status`.
    pub fn statuses(&self) -> Vec<SidecarStatus> {
        let map = match self.children.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        map.values().map(|c| c.status_snapshot()).collect()
    }

    /// Spin up a supervisor task for this pkg's first long-lived MCP entry.
    /// Idempotent: re-registering the same pkg with the same install_path
    /// is a no-op (boot replay).
    fn start_supervised(&self, pkg: &Package) -> Result<()> {
        let Some(server) = pkg.manifest.mcp.iter().find(|s| s.is_long_lived()).cloned() else {
            return Ok(());
        };

        let pkg_id = pkg.manifest.id.clone();
        let install_path = pkg.install_path.clone();

        {
            let map = self
                .children
                .read()
                .map_err(|_| anyhow!("supervisor lock poisoned"))?;
            if let Some(existing) = map.get(&pkg_id) {
                if existing.install_path == install_path {
                    log::debug!(
                        "[pkg_lifecycle] supervisor for `{pkg_id}` already running (boot replay)"
                    );
                    return Ok(());
                }
            }
        }

        let supervised = Arc::new(SupervisedSidecar::new_with_app(
            pkg_id.clone(),
            server,
            install_path,
            self.app.clone(),
            self.pa_db.clone(),
        ));

        {
            let mut map = self
                .children
                .write()
                .map_err(|_| anyhow!("supervisor lock poisoned"))?;
            map.insert(pkg_id.clone(), supervised.clone());
        }

        // Spawn the per-pkg supervisor task. tauri::async_runtime::spawn
        // works from sync contexts (kernel boot replay calls register()
        // from inside block_on).
        let task = supervised.clone();
        tauri::async_runtime::spawn(async move {
            SupervisedSidecar::supervisor_loop(task).await;
        });

        Ok(())
    }

    /// Operator-driven restart. Resets state on the named pkg back to
    /// Spawning and breaks any in-flight Blocked/Crashed sleep so the
    /// supervisor re-spawns immediately. Returns Ok(false) if the pkg
    /// isn't supervised here, Ok(true) on dispatch.
    pub fn restart(&self, pkg_id: &str) -> Result<bool> {
        let handle = match self.children.read() {
            Ok(g) => g.get(pkg_id).cloned(),
            Err(_) => return Err(anyhow!("supervisor lock poisoned")),
        };
        match handle {
            Some(h) => {
                h.restart();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn shutdown_supervised(&self, pkg_id: &str) -> Result<()> {
        let removed = {
            let mut map = self
                .children
                .write()
                .map_err(|_| anyhow!("supervisor lock poisoned"))?;
            map.remove(pkg_id)
        };
        if let Some(handle) = removed {
            handle.request_shutdown();
        }
        Ok(())
    }
}

impl Registry for SidecarSupervisor {
    fn name(&self) -> &'static str {
        "sidecar_supervisor"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        self.start_supervised(pkg)
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        self.shutdown_supervised(pkg_id)
    }

    fn snapshot(&self) -> Value {
        let entries = self.statuses();
        json!({
            "count": entries.len(),
            "entries": entries,
        })
    }
}

// ── Per-pkg supervised sidecar ───────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum BlockedReason {
    /// A port the child needs is held by another process. The sidecar
    /// detected this in the dev-server child's stderr/stdout and emitted
    /// `pkg/notifications/port_in_use` before exiting code=2.
    PortInUse(u16),
}

impl BlockedReason {
    fn render(&self) -> String {
        match self {
            BlockedReason::PortInUse(port) => format!("port {port} in use"),
        }
    }
}

#[derive(Debug, Clone)]
enum State {
    Spawning,
    Running {
        pid: u32,
        started_at: Instant,
        /// Restart count carried forward from the most recent Crashed run.
        restarts: u32,
    },
    Crashed {
        retries: u32,
        first_crash_at: Instant,
        last_err: String,
    },
    /// Operator-fixable failure. Strike counter NOT incremented; supervisor
    /// re-spawns every BLOCKED_RETRY indefinitely.
    Blocked {
        reason: BlockedReason,
        last_err: String,
    },
    Parked {
        last_err: String,
    },
    ShuttingDown,
}

impl State {
    fn label(&self) -> &'static str {
        match self {
            State::Spawning => "spawning",
            State::Running { .. } => "running",
            State::Crashed { .. } => "crashed",
            State::Blocked { .. } => "blocked",
            State::Parked { .. } => "parked",
            State::ShuttingDown => "shuttingdown",
        }
    }
}

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

struct ActiveChild {
    pid: u32,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: PendingMap,
    started_at: Instant,
}

pub struct SupervisedSidecar {
    pub pkg_id: String,
    server: McpServer,
    install_path: PathBuf,
    state: StdMutex<State>,
    /// Set when the child is up and accepting tools/call. Cleared on crash
    /// or shutdown.
    active: StdMutex<Option<ActiveChild>>,
    /// Per-child JSON-RPC id allocator. Starts at 100 so handshake ids
    /// (1, 2) never collide with tool-call ids.
    next_id: AtomicU64,
    /// Notified by `request_shutdown` to break the supervisor loop.
    shutdown: Notify,
    /// Notified by `restart()` (operator action) to break out of any
    /// pending sleep — Blocked retry, RESTART_DELAY, etc. — and re-spawn
    /// immediately.
    restart_kick: Notify,
    /// Set by the read-loop when the child emits
    /// `pkg/notifications/port_in_use` (or any future operator-fixable
    /// notification). Consumed once by the supervisor on the next crash
    /// transition; cleared on each Spawning entry. Arc-wrapped so the
    /// spawned reader task can hold a clone.
    blocked_signal: Arc<StdMutex<Option<BlockedReason>>>,
    /// Tauri AppHandle for emitting `pkg://lifecycle` events. None in unit
    /// tests; emit becomes a no-op when absent.
    app: Option<AppHandle>,
    /// Phase 5 (projects-first-class): DB handle for resolving the pkg's
    /// own scope (workspace vs project-pkg) + the active-project fallback
    /// at spawn time. Read once per spawn so `IKENGA_PROJECT_ID` reflects
    /// the *current* active project for workspace-scoped pkgs (i.e. when
    /// the user switches projects, a workspace MCP that respawns after a
    /// crash picks up the new active id). `None` in unit tests; env
    /// injection becomes a no-op.
    pa_db: Option<Arc<crate::commands::db::PaDb>>,
}

impl SupervisedSidecar {
    #[cfg(test)]
    fn new(pkg_id: String, server: McpServer, install_path: PathBuf) -> Self {
        Self::new_with_app(pkg_id, server, install_path, None, None)
    }

    fn new_with_app(
        pkg_id: String,
        server: McpServer,
        install_path: PathBuf,
        app: Option<AppHandle>,
        pa_db: Option<Arc<crate::commands::db::PaDb>>,
    ) -> Self {
        Self {
            pkg_id,
            server,
            install_path,
            state: StdMutex::new(State::Spawning),
            active: StdMutex::new(None),
            next_id: AtomicU64::new(100),
            shutdown: Notify::new(),
            restart_kick: Notify::new(),
            blocked_signal: Arc::new(StdMutex::new(None)),
            app,
            pa_db,
        }
    }

    /// Translate the internal `State` to the FE-visible 3-state surface and
    /// emit on `pkg://lifecycle`. ShuttingDown is intentionally unrendered
    /// (the pkg is gone; no sensible UI). Best-effort: any emit failure is
    /// logged and swallowed.
    fn emit_lifecycle(&self, state: &State) {
        let Some(app) = self.app.as_ref() else { return };
        let kind = match state {
            State::Spawning => LifecycleKind::Booting,
            State::Running { .. } => LifecycleKind::Ready,
            State::Crashed { last_err, .. } => LifecycleKind::Error {
                reason: last_err.clone(),
            },
            State::Blocked { last_err, .. } => LifecycleKind::Error {
                reason: last_err.clone(),
            },
            State::Parked { last_err } => LifecycleKind::Error {
                reason: last_err.clone(),
            },
            State::ShuttingDown => return,
        };
        let payload = LifecycleEvent {
            pkg_id: self.pkg_id.clone(),
            state: kind,
        };
        if let Err(e) = app.emit(LIFECYCLE_EVENT, payload) {
            log::warn!(
                "[pkg_lifecycle] `{}` emit lifecycle failed: {e}",
                self.pkg_id
            );
        }
    }

    fn blocked_signal_handle(&self) -> Arc<StdMutex<Option<BlockedReason>>> {
        self.blocked_signal.clone()
    }

    fn take_blocked_signal(&self) -> Option<BlockedReason> {
        self.blocked_signal
            .lock()
            .expect("blocked_signal poisoned")
            .take()
    }

    fn clear_blocked_signal(&self) {
        let _ = self.take_blocked_signal();
    }

    fn set_state(&self, s: State) {
        let label = s.label();
        log::info!("[pkg_lifecycle] `{}` → {label}", self.pkg_id);
        // Emit before storing so the closure-captured `s` is still readable
        // without re-acquiring the lock. Drops the lock before any FE work.
        self.emit_lifecycle(&s);
        *self.state.lock().expect("state lock poisoned") = s;
    }

    fn current_state(&self) -> State {
        self.state.lock().expect("state lock poisoned").clone()
    }

    fn request_shutdown(&self) {
        self.set_state(State::ShuttingDown);
        self.shutdown.notify_waiters();
    }

    pub fn status_snapshot(&self) -> SidecarStatus {
        let state = self.current_state();
        let active = self.active.lock().expect("active lock poisoned");
        let (pid, uptime_s) = match active.as_ref() {
            Some(a) => (Some(a.pid), Some(a.started_at.elapsed().as_secs())),
            None => (None, None),
        };
        let (restarts, last_err) = match &state {
            State::Running { restarts, .. } => (*restarts, None),
            State::Crashed {
                retries, last_err, ..
            } => (*retries, Some(last_err.clone())),
            State::Blocked { last_err, .. } => (0, Some(last_err.clone())),
            State::Parked { last_err } => (MAX_RETRIES, Some(last_err.clone())),
            _ => (0, None),
        };
        SidecarStatus {
            pkg_id: self.pkg_id.clone(),
            state: state.label(),
            pid,
            uptime_s,
            restarts,
            last_crash_unix_ms: if last_err.is_some() {
                Some(chrono::Utc::now().timestamp_millis())
            } else {
                None
            },
            last_err,
        }
    }

    /// Public entry point for `mcp_runtime::call_tool_supervised`. Returns
    /// an error if the child is not currently Running.
    pub async fn call_tool(&self, tool: &str, args: Value) -> Result<Value> {
        let (stdin_tx, pending, id) = {
            let active = self.active.lock().expect("active lock poisoned");
            let Some(a) = active.as_ref() else {
                let label = self.current_state().label();
                return Err(anyhow!(
                    "supervised sidecar for `{}` is not running (state={label})",
                    self.pkg_id
                ));
            };
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            (a.stdin_tx.clone(), a.pending.clone(), id)
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut p = pending.lock().expect("pending lock poisoned");
            p.insert(id, tx);
        }

        let mut frame = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        }))?;
        frame.push(b'\n');

        if stdin_tx.send(frame).await.is_err() {
            let mut p = pending.lock().expect("pending lock poisoned");
            p.remove(&id);
            return Err(anyhow!(
                "supervised sidecar for `{}` stdin closed",
                self.pkg_id
            ));
        }

        let outcome = match timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("child exited before responding".to_string()),
            Err(_) => {
                let mut p = pending.lock().expect("pending lock poisoned");
                p.remove(&id);
                return Err(anyhow!(
                    "supervised tools/call `{tool}` timed out after {:?}",
                    CALL_TIMEOUT
                ));
            }
        };
        outcome.map_err(|e| anyhow!("{e}"))
    }

    /// The supervisor task body. Runs spawn / handshake / wait / restart
    /// until shutdown. One instance per supervised pkg.
    async fn supervisor_loop(self_arc: Arc<Self>) {
        loop {
            if matches!(self_arc.current_state(), State::ShuttingDown) {
                self_arc.tear_down_active().await;
                return;
            }
            self_arc.set_state(State::Spawning);
            self_arc.clear_blocked_signal();

            // Per-cycle crash signal. `oneshot` has correct
            // already-fired-before-await semantics: if the read-loop
            // sends() before we await rx, the await still resolves.
            let (crash_tx, crash_rx) = oneshot::channel::<()>();

            match self_arc.spawn_and_handshake(crash_tx).await {
                Ok(child) => {
                    let shutdown = self_arc.shutdown.notified();
                    tokio::pin!(shutdown);
                    tokio::pin!(crash_rx);
                    tokio::select! {
                        _ = &mut crash_rx => {
                            log::warn!("[pkg_lifecycle] `{}` child exited", self_arc.pkg_id);
                            drop(child);
                            self_arc.clear_active();
                            // Read-loop captures port_in_use notifications
                            // into blocked_signal *before* EOF fires, so
                            // by the time we reach this branch the cell
                            // already reflects the right outcome.
                            if let Some(reason) = self_arc.take_blocked_signal() {
                                self_arc.note_blocked(reason);
                            } else {
                                self_arc.note_crash_after_run(
                                    "child exited unexpectedly".into(),
                                );
                            }
                        }
                        _ = &mut shutdown => {
                            log::info!("[pkg_lifecycle] `{}` shutdown signalled", self_arc.pkg_id);
                            self_arc.tear_down_active().await;
                            drop(child);
                            return;
                        }
                    }
                }
                Err(e) => {
                    log::error!(
                        "[pkg_lifecycle] `{}` spawn/handshake failed: {e:#}",
                        self_arc.pkg_id
                    );
                    if let Some(reason) = self_arc.take_blocked_signal() {
                        self_arc.note_blocked(reason);
                    } else {
                        self_arc.note_crash_after_run(format!("{e:#}"));
                    }
                }
            }

            // Decide what to do with the run that just ended.
            match self_arc.decide_next() {
                NextAction::RetryAfterCrash => {
                    if !self_arc.sleep_or_kicked(RESTART_DELAY).await {
                        self_arc.set_state(State::ShuttingDown);
                        return;
                    }
                }
                NextAction::RetryBlocked => {
                    log::info!(
                        "[pkg_lifecycle] `{}` blocked; retrying in {:?}",
                        self_arc.pkg_id,
                        BLOCKED_RETRY
                    );
                    if !self_arc.sleep_or_kicked(BLOCKED_RETRY).await {
                        self_arc.set_state(State::ShuttingDown);
                        return;
                    }
                }
                NextAction::Park | NextAction::Stop => return,
            }
        }
    }

    /// Sleep up to `dur`, but break early on either shutdown (returns
    /// false → caller should bail) or restart_kick (returns true → caller
    /// proceeds with the next iteration immediately).
    async fn sleep_or_kicked(&self, dur: Duration) -> bool {
        let shutdown = self.shutdown.notified();
        let kick = self.restart_kick.notified();
        tokio::pin!(shutdown);
        tokio::pin!(kick);
        tokio::select! {
            _ = tokio::time::sleep(dur) => true,
            _ = &mut kick => true,
            _ = &mut shutdown => false,
        }
    }

    /// Operator action. Forces a transition back to Spawning and breaks
    /// any in-flight sleep. Idempotent for already-Spawning/Running pkgs.
    /// For Parked pkgs the supervisor task already exited, so we have to
    /// re-spawn it; restart() takes a self-Arc to allow that.
    pub fn restart(self: &Arc<Self>) {
        let was_terminal = matches!(self.current_state(), State::Parked { .. });
        // Kick is harmless if no-one is sleeping.
        self.restart_kick.notify_waiters();
        // If Parked, the supervisor loop already returned; we have to
        // launch a fresh task. Reset state under the lock first so the
        // new task sees Spawning, not Parked.
        if was_terminal {
            self.set_state(State::Spawning);
            self.clear_blocked_signal();
            let task = self.clone();
            tauri::async_runtime::spawn(async move {
                SupervisedSidecar::supervisor_loop(task).await;
            });
        }
    }

    fn clear_active(&self) {
        let _ = self.active.lock().expect("active lock poisoned").take();
    }

    /// Update the Crashed state after a run ends. Merges retries with any
    /// existing Crashed state inside the sliding window; resets when the
    /// window has expired.
    fn note_crash_after_run(&self, err: String) {
        let next_state = {
            let state = self.state.lock().expect("state lock poisoned");
            let now = Instant::now();
            match &*state {
                State::Crashed {
                    retries,
                    first_crash_at,
                    ..
                } => {
                    let (next_retries, next_first) =
                        if now.duration_since(*first_crash_at) > CRASH_WINDOW {
                            (1, now)
                        } else {
                            (retries + 1, *first_crash_at)
                        };
                    State::Crashed {
                        retries: next_retries,
                        first_crash_at: next_first,
                        last_err: err,
                    }
                }
                _ => State::Crashed {
                    retries: 1,
                    first_crash_at: now,
                    last_err: err,
                },
            }
        };
        // Drops the lock before set_state re-acquires it + emits.
        self.set_state(next_state);
    }

    /// Set the state to Blocked. Strike counter is intentionally NOT
    /// touched — Blocked is operator-fixable and the supervisor will
    /// retry every BLOCKED_RETRY indefinitely. If a prior Crashed window
    /// was active, it stays implicit (any subsequent real crash will
    /// resume the strike count from zero, which is fine — port collisions
    /// shouldn't poison the strike accounting).
    fn note_blocked(&self, reason: BlockedReason) {
        let last_err = reason.render();
        self.set_state(State::Blocked { reason, last_err });
    }

    fn decide_next(&self) -> NextAction {
        let action_and_park = {
            let state = self.state.lock().expect("state lock poisoned");
            match &*state {
                State::Crashed {
                    retries, last_err, ..
                } => {
                    if *retries >= MAX_RETRIES {
                        Some(format!("parked after {MAX_RETRIES} restarts: {last_err}"))
                    } else {
                        None
                    }
                }
                State::Blocked { .. } => return NextAction::RetryBlocked,
                State::ShuttingDown => return NextAction::Stop,
                _ => return NextAction::Stop,
            }
        };
        if let Some(park_msg) = action_and_park {
            self.set_state(State::Parked { last_err: park_msg });
            log::error!(
                "[pkg_lifecycle] `{}` parked after {MAX_RETRIES} restarts inside {:?}",
                self.pkg_id,
                CRASH_WINDOW
            );
            NextAction::Park
        } else {
            NextAction::RetryAfterCrash
        }
    }

    /// Drop the active child entry, closing its stdin channel so the
    /// writer task exits. The kill_on_drop flag on Command makes sure the
    /// OS process is reaped if it hasn't exited yet.
    async fn tear_down_active(&self) {
        let active = self.active.lock().expect("active lock poisoned").take();
        if let Some(a) = active {
            // Close stdin channel — writer task drops its half, child sees
            // stdin EOF, well-behaved MCP servers exit. Pending senders
            // get drained below so nobody hangs.
            drop(a.stdin_tx);
            let mut pending = a.pending.lock().expect("pending lock poisoned");
            for (_id, tx) in pending.drain() {
                let _ = tx.send(Err("supervised sidecar shutting down".into()));
            }
        }
    }

    /// Spawn the child, run the MCP handshake, install ActiveChild on
    /// success. On any error the child is dropped (kill_on_drop reaps it)
    /// and Err is returned — caller handles the crash transition.
    async fn spawn_and_handshake(&self, crash_tx: oneshot::Sender<()>) -> Result<Child> {
        let mut cmd = Command::new(crate::runtime::resolve_command(&self.server.command));
        cmd.args(&self.server.args);
        cmd.current_dir(&self.install_path);

        // Phase 5 (projects-first-class): inject IKENGA_PROJECT_ID +
        // IKENGA_PROJECT_ROOT before the manifest-declared env so a pkg
        // can still override either (rare but possible). Looked up per
        // spawn — workspace-scoped pkgs see the current active project,
        // project-scoped pkgs see their own. DB-less in unit tests; the
        // env vars are simply omitted in that case.
        if let Some(db) = self.pa_db.as_ref() {
            if let Ok(pool) = db.ensure_pool().await {
                let pkg_project = sqlx::query_scalar::<_, Option<String>>(
                    "SELECT project_id FROM pkg_installed WHERE id = ?",
                )
                .bind(&self.pkg_id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .flatten();
                let (id, root) = crate::commands::projects::resolve_project_env_ctx(
                    &pool,
                    pkg_project.as_deref(),
                )
                .await;
                // Phase 7: layer workspace + project `.env` files BEFORE
                // the manifest-declared env, so the manifest can still
                // override either. workspace.env lives in app_data_dir;
                // project files live at project root. Process env is
                // already inherited by `Command::new`.
                if let Some(app) = self.app.as_ref() {
                    let app_data = {
                        use tauri::Manager;
                        app.path().app_data_dir().ok()
                    };
                    let ws_env = app_data.as_ref().map(|d| d.join("workspace.env"));
                    let root_path = root.as_ref().map(std::path::PathBuf::from);
                    let layered = crate::env_files::build_layered_env(
                        ws_env.as_deref(),
                        root_path.as_deref(),
                    );
                    if !layered.is_empty() {
                        cmd.envs(layered);
                    }
                }
                if let Some(id) = id {
                    cmd.env("IKENGA_PROJECT_ID", id);
                }
                if let Some(root) = root {
                    cmd.env("IKENGA_PROJECT_ROOT", root);
                }
            }
        }

        for (k, v) in &self.server.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn `{} {:?}`", self.server.command, self.server.args))?;

        let pid = child.id().unwrap_or(0);
        let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take();

        // Stderr drainer: prevents the OS pipe from filling up.
        if let Some(stderr) = stderr {
            let pkg_id_for_err = self.pkg_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("[pkg_lifecycle.{pkg_id_for_err}.stderr] {line}");
                }
            });
        }

        // Handshake (sync within INIT_TIMEOUT, before we expose ActiveChild).
        let handshake_result = timeout(INIT_TIMEOUT, async {
            let mut init_msg = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
                },
            }))?;
            init_msg.push(b'\n');
            stdin
                .write_all(&init_msg)
                .await
                .context("write initialize")?;
            stdin.flush().await.ok();

            let mut reader = BufReader::new(stdout);
            let _init_resp = read_one_response(&mut reader, 1).await?;

            let mut notif = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            }))?;
            notif.push(b'\n');
            stdin.write_all(&notif).await.context("write initialized")?;
            stdin.flush().await.ok();

            Ok::<_, anyhow::Error>((stdin, reader))
        })
        .await;

        let (stdin, reader) = match handshake_result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(anyhow!("initialize timed out after {:?}", INIT_TIMEOUT)),
        };

        // Wire up the long-lived writer + reader tasks.
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);

        let pkg_id_for_writer = self.pkg_id.clone();
        let mut writer_stdin = stdin;
        tauri::async_runtime::spawn(async move {
            while let Some(buf) = stdin_rx.recv().await {
                if let Err(e) = writer_stdin.write_all(&buf).await {
                    log::warn!("[pkg_lifecycle.{pkg_id_for_writer}] stdin write failed: {e}");
                    break;
                }
                let _ = writer_stdin.flush().await;
            }
            // Dropping writer_stdin closes the child's stdin pipe.
        });

        let pending_for_reader = pending.clone();
        let pkg_id_for_reader = self.pkg_id.clone();
        let blocked_signal_for_reader: Arc<StdMutex<Option<BlockedReason>>> =
            self.blocked_signal_handle();
        tauri::async_runtime::spawn(async move {
            read_loop(
                reader,
                pending_for_reader,
                &pkg_id_for_reader,
                blocked_signal_for_reader,
            )
            .await;
            // Signal the supervisor that the child died. Send is fire-and-
            // forget — if the receiver is gone (shutdown beat us), no harm.
            let _ = crash_tx.send(());
        });

        // Install ActiveChild and flip state to Running.
        {
            let mut active = self.active.lock().expect("active lock poisoned");
            *active = Some(ActiveChild {
                pid,
                stdin_tx,
                pending,
                started_at: Instant::now(),
            });
        }

        let prior_restarts = match self.current_state() {
            State::Crashed { retries, .. } => retries,
            _ => 0,
        };
        self.set_state(State::Running {
            pid,
            started_at: Instant::now(),
            restarts: prior_restarts,
        });

        Ok(child)
    }
}

#[derive(Debug)]
enum NextAction {
    /// Crash path: sleep RESTART_DELAY then re-spawn (subject to strike cap).
    RetryAfterCrash,
    /// Operator-fixable path: sleep BLOCKED_RETRY then re-spawn, no cap.
    RetryBlocked,
    /// Strike cap hit; transition to Parked and exit the supervisor loop.
    Park,
    /// Shutdown or other terminal exit.
    Stop,
}

// ── Read loop ────────────────────────────────────────────────────────────────

async fn read_loop<R: tokio::io::AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    pending: PendingMap,
    pkg_id: &str,
    blocked_signal: Arc<StdMutex<Option<BlockedReason>>>,
) {
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!(
                            "[pkg_lifecycle.{pkg_id}.read_loop] non-JSON: {e}: {trimmed:.120}"
                        );
                        continue;
                    }
                };
                let Some(id) = v.get("id").and_then(Value::as_u64) else {
                    // Notification path. Today only port_in_use is
                    // honored — the sidecar emits this just before exiting
                    // code=2 so the supervisor can transition to Blocked
                    // (no strike) on the upcoming EOF.
                    if let Some(method) = v.get("method").and_then(Value::as_str) {
                        if method == "pkg/notifications/port_in_use" {
                            let port = v
                                .get("params")
                                .and_then(|p| p.get("port"))
                                .and_then(Value::as_u64)
                                .map(|p| p as u16)
                                .unwrap_or(0);
                            log::warn!(
                                "[pkg_lifecycle.{pkg_id}.read_loop] port_in_use port={port}"
                            );
                            *blocked_signal.lock().expect("blocked_signal poisoned") =
                                Some(BlockedReason::PortInUse(port));
                        }
                    }
                    continue;
                };
                let tx = {
                    let mut p = pending.lock().expect("pending lock poisoned");
                    p.remove(&id)
                };
                let Some(tx) = tx else {
                    log::debug!("[pkg_lifecycle.{pkg_id}.read_loop] orphan id={id}");
                    continue;
                };
                if let Some(err) = v.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    let _ = tx.send(Err(format!("rpc error: {msg}")));
                } else if let Some(result) = v.get("result") {
                    let _ = tx.send(Ok(result.clone()));
                } else {
                    let _ = tx.send(Err("response had no result and no error".into()));
                }
            }
            Err(e) => {
                log::warn!("[pkg_lifecycle.{pkg_id}.read_loop] read error: {e}");
                break;
            }
        }
    }
    // Drain any pending callers with an error.
    let mut p = pending.lock().expect("pending lock poisoned");
    for (_id, tx) in p.drain() {
        let _ = tx.send(Err("child exited (stdout closed)".into()));
    }
}

async fn read_one_response<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    want_id: u64,
) -> Result<Value> {
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader.read_line(&mut buf).await.context("read stdout")?;
        if n == 0 {
            return Err(anyhow!("stdout closed before id={want_id}"));
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("id").and_then(Value::as_u64) {
            Some(id) if id == want_id => {
                if let Some(err) = v.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    return Err(anyhow!("rpc error: {msg}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            _ => continue,
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg::manifest::Manifest;

    fn fake_pkg(lifecycle: Option<&str>, command: &str) -> Package {
        let mut m = Manifest {
            id: "com.royalti.testlife".into(),
            name: "T".into(),
            version: "0.1.0".into(),
            ikenga_api: "1".into(),
            kind: None,
            author: None,
            targets: vec![],
            skills: None,
            commands: None,
            agents: None,
            mcp: vec![],
            sidecars: vec![],
            permissions: Default::default(),
            migrations: None,
            settings: None,
            ui: None,
            iyke: None,
            cron: vec![],
            window: None,
            queries: None,
            capabilities: None,
            engine: None,
        };
        m.mcp.push(McpServer {
            name: "t".into(),
            command: command.into(),
            args: vec![],
            env: HashMap::new(),
            lifecycle: lifecycle.map(String::from),
        });
        Package {
            manifest: m,
            install_path: PathBuf::from("/tmp"),
        }
    }

    #[test]
    fn supervisor_skips_per_call_entries() {
        let sup = SidecarSupervisor::new();
        let pkg = fake_pkg(None, "/bin/true");
        sup.register(&pkg).expect("register");
        assert!(sup.statuses().is_empty());
    }

    /// Note: this test depends on a tokio runtime being available so the
    /// supervisor task can spawn. Marked tokio::test for that reason —
    /// even though the test only checks the synchronous register path.
    #[tokio::test]
    async fn supervisor_picks_up_long_lived_entry() {
        let sup = SidecarSupervisor::new();
        let pkg = fake_pkg(Some("long-lived"), "/bin/false");
        sup.register(&pkg).expect("register");
        let statuses = sup.statuses();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].pkg_id, "com.royalti.testlife");
    }

    #[tokio::test]
    async fn unregister_is_idempotent_and_removes_entry() {
        let sup = SidecarSupervisor::new();
        let pkg = fake_pkg(Some("long-lived"), "/bin/false");
        sup.register(&pkg).expect("register");
        sup.unregister("com.royalti.testlife").expect("unregister");
        assert!(sup.statuses().is_empty());
        sup.unregister("com.royalti.testlife").expect("idempotent");
    }

    #[test]
    fn note_crash_increments_within_window_and_parks_at_three() {
        let sidecar = SupervisedSidecar::new(
            "x".into(),
            McpServer {
                name: "t".into(),
                command: "/bin/false".into(),
                args: vec![],
                env: HashMap::new(),
                lifecycle: Some("long-lived".into()),
            },
            PathBuf::from("/tmp"),
        );
        sidecar.note_crash_after_run("first".into());
        match sidecar.current_state() {
            State::Crashed { retries: 1, .. } => {}
            other => panic!("expected Crashed retries=1, got {other:?}"),
        }
        sidecar.note_crash_after_run("second".into());
        match sidecar.current_state() {
            State::Crashed { retries: 2, .. } => {}
            other => panic!("expected Crashed retries=2, got {other:?}"),
        }
        sidecar.note_crash_after_run("third".into());
        match sidecar.decide_next() {
            NextAction::Park => {}
            other => panic!("expected Park, got {other:?}"),
        }
        match sidecar.current_state() {
            State::Parked { .. } => {}
            other => panic!("expected Parked, got {other:?}"),
        }
    }

    #[test]
    fn note_crash_with_port_in_use_does_not_park() {
        let sidecar = SupervisedSidecar::new(
            "x".into(),
            McpServer {
                name: "t".into(),
                command: "/bin/false".into(),
                args: vec![],
                env: HashMap::new(),
                lifecycle: Some("long-lived".into()),
            },
            PathBuf::from("/tmp"),
        );
        // Five port-in-use signals — well past MAX_RETRIES. Must never
        // transition to Parked; must always end up Blocked with the
        // RetryBlocked decision.
        for _ in 0..5 {
            sidecar.note_blocked(BlockedReason::PortInUse(3105));
            match sidecar.current_state() {
                State::Blocked { .. } => {}
                other => panic!("expected Blocked, got {other:?}"),
            }
            match sidecar.decide_next() {
                NextAction::RetryBlocked => {}
                other => panic!("expected RetryBlocked, got {other:?}"),
            }
        }
        // last_err carries through into status snapshot.
        let snap = sidecar.status_snapshot();
        assert_eq!(snap.state, "blocked");
        assert_eq!(snap.last_err.as_deref(), Some("port 3105 in use"));
        // Strike counter never advanced.
        assert_eq!(snap.restarts, 0);
    }

    #[tokio::test]
    async fn supervisor_restart_clears_blocked_state() {
        let sidecar = Arc::new(SupervisedSidecar::new(
            "x".into(),
            McpServer {
                name: "t".into(),
                command: "/bin/false".into(),
                args: vec![],
                env: HashMap::new(),
                lifecycle: Some("long-lived".into()),
            },
            PathBuf::from("/tmp"),
        ));
        sidecar.note_blocked(BlockedReason::PortInUse(3105));
        match sidecar.current_state() {
            State::Blocked { .. } => {}
            other => panic!("expected Blocked, got {other:?}"),
        }
        // From Blocked, restart() only kicks the sleep (no spawn) since
        // the loop hasn't exited; we mimic that by checking the kick is
        // notified without spawning a fresh task.
        sidecar.restart();
        // Manually transition through Parked to exercise the Parked path
        // too: restart() must reset state to Spawning and (in production)
        // launch a fresh supervisor task.
        sidecar.set_state(State::Parked {
            last_err: "test".into(),
        });
        sidecar.restart();
        match sidecar.current_state() {
            State::Spawning => {}
            other => panic!("expected Spawning after restart from Parked, got {other:?}"),
        }
    }
}
