//! Portable-PTY session pool. One `PtyManager` instance per app, holding a
//! `DashMap<String, PtySession>` keyed by short uuid.
//!
//! Each session runs:
//!  - a blocking reader thread (portable-pty's reader is sync) that pumps stdout
//!    bytes into a tokio mpsc channel
//!  - a tokio task that batches those bytes into ≤8KB chunks at ~120Hz, base64
//!    encodes them, and emits them on the `pty://{id}` Tauri event
//!  - a child waiter that emits `pty://{id}/exit` with the exit code on death

pub mod foreground;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use uuid::Uuid;

const CHUNK_SIZE: usize = 8 * 1024;
const FLUSH_INTERVAL_MS: u64 = 8; // ≈120 Hz
/// Cap on the per-session scrollback ring. A late-attaching window (a popped-out
/// terminal) replays at most this many trailing bytes before subscribing live.
const SCROLLBACK_CAP: usize = 256 * 1024;

/// Bounded ring of the bytes emitted on `pty://{id}`, plus a monotonic `total`
/// of every byte ever emitted. `total` keeps growing after the tail is trimmed
/// so a scrollback snapshot's end offset stays comparable with the offsets
/// carried on live events — the frontend uses that to drop the overlap between
/// a snapshot and the first live bytes it buffered while attaching.
struct ScrollbackRing {
    buf: std::collections::VecDeque<u8>,
    total: u64,
}

impl ScrollbackRing {
    fn new() -> Self {
        Self {
            buf: std::collections::VecDeque::new(),
            total: 0,
        }
    }

    /// Record freshly-emitted bytes; returns the cumulative end offset
    /// (including this push) so the caller can tag the matching live event.
    fn push(&mut self, data: &[u8]) -> u64 {
        self.total += data.len() as u64;
        self.buf.extend(data.iter().copied());
        while self.buf.len() > SCROLLBACK_CAP {
            self.buf.pop_front();
        }
        self.total
    }

    /// (trailing bytes, end offset). `end - bytes.len()` is the absolute offset
    /// of the first returned byte.
    fn snapshot(&self) -> (Vec<u8>, u64) {
        (self.buf.iter().copied().collect(), self.total)
    }
}

/// Wrapper for `MasterPty::process_group_leader`, which is `#[cfg(unix)]` in
/// portable-pty 0.8. On Windows there's no PTY foreground-PG concept, so we
/// surface `None` and let callers degrade gracefully.
#[cfg(unix)]
fn master_process_group_leader(master: &dyn MasterPty) -> Option<i32> {
    master.process_group_leader()
}

#[cfg(not(unix))]
fn master_process_group_leader(_master: &dyn MasterPty) -> Option<i32> {
    None
}

pub struct SpawnOpts {
    pub cwd: String,
    pub cmd: Vec<String>,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
}

/// Async callback for byte-level subscribers attached *after* spawn (e.g.
/// the Claude session parser, which also wants the raw PTY bytes that the
/// xterm frontend gets). Subscribers see chunks pre-base64, in the order the
/// reader thread saw them. Errors are swallowed — subscribers detach by
/// dropping the boxed future on the next tick.
pub type ByteSubscriber = Box<dyn Fn(&[u8]) + Send + Sync + 'static>;

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    /// Used to signal the reader thread to stop.
    killed: Arc<std::sync::atomic::AtomicBool>,
    /// Killer to terminate the child process directly.
    child_killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    /// Optional byte tap. Set once at spawn time via `spawn_with_subscriber`;
    /// kept as a `Mutex<Option<_>>` rather than baked into the spawn opts so
    /// callers without a subscriber don't pay any cost.
    subscriber: Mutex<Option<ByteSubscriber>>,
    /// Trailing scrollback of the emitted `pty://{id}` stream, so a window that
    /// attaches late can replay it before subscribing live.
    scrollback: Mutex<ScrollbackRing>,
}

pub struct PtyManager {
    sessions: DashMap<String, Arc<PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub async fn spawn(self: &Arc<Self>, app: AppHandle, opts: SpawnOpts) -> Result<String> {
        self.spawn_inner(app, opts, None).await
    }

    /// Spawn with a byte subscriber attached. The subscriber sees raw PTY
    /// bytes alongside the normal `pty://{id}` event emission; used by the
    /// Claude session integration to feed `StreamParser`.
    pub async fn spawn_with_subscriber(
        self: &Arc<Self>,
        app: AppHandle,
        opts: SpawnOpts,
        subscriber: ByteSubscriber,
    ) -> Result<String> {
        self.spawn_inner(app, opts, Some(subscriber)).await
    }

    async fn spawn_inner(
        self: &Arc<Self>,
        app: AppHandle,
        opts: SpawnOpts,
        subscriber: Option<ByteSubscriber>,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let event_name = format!("pty://{id}");
        let exit_event = format!("pty://{id}/exit");

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        // Resolve `~/...` and shell vars in cwd.
        let resolved_cwd = shellexpand::full(&opts.cwd)
            .map(|c| c.into_owned())
            .unwrap_or(opts.cwd.clone());

        let mut builder = CommandBuilder::new(&opts.cmd[0]);
        if opts.cmd.len() > 1 {
            builder.args(&opts.cmd[1..]);
        }
        builder.cwd(&resolved_cwd);

        // Inherit a sane PATH from the parent process so `claude` (and friends
        // installed in user-local bins) resolve. portable-pty does not inherit
        // env by default.
        for (k, v) in std::env::vars() {
            builder.env(&k, &v);
        }
        // Override PATH with the augmented one (ADR-013 §Addendum Decision 2)
        // so interactive auth terminals (`gemini auth`, `codex login`) and any
        // agent CLI launched in a pane resolve under nvm/npm/homebrew even when
        // the app inherited a thin GUI $PATH. Caller env below still wins.
        builder.env("PATH", crate::runtime::augmented_path());
        // Caller-supplied env wins.
        for (k, v) in &opts.env {
            builder.env(k, v);
        }
        // Sensible terminal defaults for full-screen TUIs (claude, vim, htop).
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");

        let mut child = pair.slave.spawn_command(builder).context("spawn child")?;
        let child_killer = child.clone_killer();

        let writer = pair.master.take_writer().context("take writer")?;
        let reader = pair.master.try_clone_reader().context("clone reader")?;

        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let session = Arc::new(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killed: killed.clone(),
            child_killer: Mutex::new(child_killer),
            subscriber: Mutex::new(subscriber),
            scrollback: Mutex::new(ScrollbackRing::new()),
        });

        self.sessions.insert(id.clone(), session.clone());

        // --- Reader thread: blocking → mpsc + optional subscriber ---
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(256);
        let killed_for_reader = killed.clone();
        let session_for_reader = session.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; CHUNK_SIZE];
            loop {
                if killed_for_reader.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if let Ok(guard) = session_for_reader.subscriber.lock() {
                            if let Some(sub) = guard.as_ref() {
                                sub(chunk);
                            }
                        }
                        if tx.blocking_send(chunk.to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        log::debug!("pty reader closed: {e}");
                        break;
                    }
                }
            }
        });

        // --- Emitter task: batch → ring + base64 → Tauri event ---
        let app_for_emit = app.clone();
        let event_name_for_emit = event_name.clone();
        let session_for_emit = session.clone();
        tokio::spawn(async move {
            let engine = base64::engine::general_purpose::STANDARD;
            // Record the chunk in the scrollback ring and emit it tagged with its
            // cumulative end offset (`<endOffset>:<base64>`). The offset lets a
            // late-attaching window reconcile a scrollback snapshot against the
            // first live bytes it buffers without duplicating the overlap.
            let emit_chunk = |bytes: &[u8]| {
                let end_offset = match session_for_emit.scrollback.lock() {
                    Ok(mut sb) => sb.push(bytes),
                    Err(_) => return,
                };
                let payload = engine.encode(bytes);
                let _ = app_for_emit.emit(&event_name_for_emit, format!("{end_offset}:{payload}"));
            };
            let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_SIZE);
            let mut interval = tokio::time::interval(Duration::from_millis(FLUSH_INTERVAL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    maybe_chunk = rx.recv() => {
                        match maybe_chunk {
                            Some(chunk) => pending.extend_from_slice(&chunk),
                            None => {
                                // Channel closed, flush remainder and exit.
                                if !pending.is_empty() {
                                    emit_chunk(&pending);
                                }
                                break;
                            }
                        }
                        // Flush eagerly if we have a full chunk.
                        while pending.len() >= CHUNK_SIZE {
                            let chunk: Vec<u8> = pending.drain(..CHUNK_SIZE).collect();
                            emit_chunk(&chunk);
                        }
                    }
                    _ = interval.tick() => {
                        if !pending.is_empty() {
                            emit_chunk(&pending);
                            pending.clear();
                        }
                    }
                }
            }
        });

        // --- Child waiter: blocking thread → exit event + cleanup ---
        let manager_for_wait = self.clone();
        let id_for_wait = id.clone();
        let app_for_exit = app;
        thread::spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let _ = app_for_exit.emit(&exit_event, exit_code);
            // Drop the session entry. The reader thread will see EOF on the
            // master side and exit too.
            manager_for_wait.sessions.remove(&id_for_wait);
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow!("unknown pty id: {id}"))?
            .clone();
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| anyhow!("writer lock poisoned"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow!("unknown pty id: {id}"))?
            .clone();
        let master = session
            .master
            .lock()
            .map_err(|_| anyhow!("master lock poisoned"))?;
        master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// PID of the shell process attached to this PTY (the process-group leader
    /// of the slave side). Used by `foreground::lookup` to find what the user
    /// has running in the terminal at the moment. Returns `None` when the
    /// session has died or the platform doesn't surface a PGL.
    pub fn process_group_leader(&self, id: &str) -> Option<i32> {
        let session = self.sessions.get(id)?.clone();
        let master = session.master.lock().ok()?;
        master_process_group_leader(&**master)
    }

    /// Look up the foreground command running in this PTY (the process whose
    /// PGID matches the controlling terminal's foreground PG). Returns `None`
    /// when the session has died or the platform isn't yet supported.
    pub fn foreground(&self, id: &str) -> Option<foreground::ForegroundProcess> {
        let pid = self.process_group_leader(id)?;
        foreground::lookup(pid)
    }

    /// True when the foreground command for this PTY is `claude` (or a
    /// `claude-*` variant). The routing dispatcher uses this to filter PTYs
    /// when picking the active claude session for pin delivery.
    pub fn is_claude_foreground(&self, id: &str) -> bool {
        match self.process_group_leader(id) {
            Some(pid) => foreground::is_claude(pid),
            None => false,
        }
    }

    /// Snapshot the foreground command for every live PTY. Used by the
    /// routing dispatcher to pick the most-recently-touched claude PTY when
    /// dispatching a pin. The map is keyed by PTY id (the same id `pty_spawn`
    /// returns); only PTYs whose lookup succeeded appear in the result.
    pub fn foreground_snapshot(&self) -> HashMap<String, foreground::ForegroundProcess> {
        let mut out = HashMap::new();
        for entry in self.sessions.iter() {
            if let Some(pid) = entry
                .value()
                .master
                .lock()
                .ok()
                .and_then(|m| master_process_group_leader(&**m))
            {
                if let Some(fg) = foreground::lookup(pid) {
                    out.insert(entry.key().clone(), fg);
                }
            }
        }
        out
    }

    /// Snapshot the trailing scrollback for a session: `(bytes, end_offset)`
    /// where `end_offset` is the cumulative number of bytes ever emitted on
    /// `pty://{id}` and the returned bytes are the last ≤`SCROLLBACK_CAP` of
    /// them (so the first byte's absolute offset is `end_offset - bytes.len()`).
    /// `None` once the session has exited and been reaped.
    pub fn scrollback(&self, id: &str) -> Option<(Vec<u8>, u64)> {
        let session = self.sessions.get(id)?.clone();
        let sb = session.scrollback.lock().ok()?;
        Some(sb.snapshot())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let session = match self.sessions.get(id) {
            Some(s) => s.clone(),
            // Already gone — kill is idempotent.
            None => return Ok(()),
        };
        session
            .killed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut killer) = session.child_killer.lock() {
            let _ = killer.kill();
        }
        // The wait thread will remove the entry once the child reaps.
        Ok(())
    }
}
