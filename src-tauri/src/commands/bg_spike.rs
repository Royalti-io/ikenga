//! Phase 0.5 background-execution spike. Debug-only.
//!
//! Measures host → webview → host eval round-trip latency to gauge how
//! aggressively OS-level focus/visibility throttling affects the surface
//! `pkg-browser` will rely on. See `shell/CLAUDE.md` "Pane mount model"
//! section for the wider context; results land in the same file as a
//! "Phase 0.5 findings" subsection.
//!
//! Why it pairs two commands:
//!  - Tauri 2's `WebviewWindow::eval` is fire-and-forget; the host gets no
//!    direct timing signal back. So `bg_spike_run` evals a snippet that
//!    calls `window.__bgSpikeReply(nonce)` in the page, which invokes
//!    `bg_spike_reply(nonce)` back into Rust. Round-trip is t_reply - t_eval.
//!  - This measures the actual latency the model will experience when a
//!    browser MCP tool dispatches an action — eval + page exec + return path.
//!
//! Usage (DevTools console, dev mode):
//!
//!   const inv = window.__TAURI__.core.invoke;
//!   // 1. Ensure the reply hook is installed (idempotent, see main.tsx).
//!   window.__bgSpikeInstall();
//!   // 2. Kick off a 60s run, one ping every 500ms, 5s per-ping timeout.
//!   const r = await inv('bg_spike_run', {
//!     durationMs: 60000, intervalMs: 500, perPingTimeoutMs: 5000,
//!   });
//!   console.table({
//!     intended: r.intendedCount, done: r.completedCount,
//!     timeouts: r.timeoutCount,
//!     p50_ms: r.p50Us/1000, p95_ms: r.p95Us/1000,
//!     p99_ms: r.p99Us/1000, max_ms: r.maxUs/1000,
//!   });
//!
//! Run once focused as baseline, then repeat with the window minimized,
//! the app backgrounded behind another app, and the screen off. Compare.
//!
//! Hard-removed before `pkg-browser` ships — this command and its FE hook
//! are gated behind `cfg(debug_assertions)` on the Rust side and behind
//! `import.meta.env.DEV` on the FE side.

#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;
use tokio::time::timeout;

/// Pending nonces — `bg_spike_reply` looks itself up here and fires the
/// oneshot so the run-loop can record the RTT for that ping.
#[derive(Default)]
pub struct BgSpikeState {
    pending: Mutex<HashMap<u64, oneshot::Sender<Instant>>>,
}

pub type BgSpikeStateRef = Arc<BgSpikeState>;

pub fn new_state() -> BgSpikeStateRef {
    Arc::new(BgSpikeState::default())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgSpikeReport {
    /// Total ticks attempted within the duration window.
    pub intended_count: u64,
    /// Pings whose reply landed before per-ping timeout.
    pub completed_count: u64,
    /// Pings that timed out waiting for the reply.
    pub timeout_count: u64,
    /// Actual wallclock of the run (may slightly exceed `durationMs` due
    /// to the final tick being in flight when the deadline elapses).
    pub duration_ms: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub max_us: u64,
    /// All RTT samples in microseconds, sorted ascending. Trimmed in the
    /// final report if huge — see `MAX_SAMPLES_REPORTED`.
    pub sample_us: Vec<u64>,
    /// Label of the webview that was pinged. Today always "main"; once
    /// child webviews land, the row-1 matrix entry will target a child.
    pub webview_label: String,
}

/// Cap on returned samples so a 10-minute run at 100ms intervals doesn't
/// dump 6000 rows over the IPC. Stats are computed against the full set.
const MAX_SAMPLES_REPORTED: usize = 600;

#[tauri::command]
pub async fn bg_spike_run(
    app: AppHandle,
    state: State<'_, BgSpikeStateRef>,
    duration_ms: u64,
    interval_ms: u64,
    per_ping_timeout_ms: u64,
) -> Result<BgSpikeReport, String> {
    // Debug harness pings the PRIMARY window. Parameterizing the target label
    // (a child / non-`main` window) is WP-01's measurement-spike concern — see
    // the `webview_label` field doc above; intentionally left "main".
    let label = "main";
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no webview window labeled `{label}`"))?;

    let start = Instant::now();
    let deadline = start + Duration::from_millis(duration_ms);
    let per_ping_to = Duration::from_millis(per_ping_timeout_ms);

    let mut samples_us: Vec<u64> = Vec::new();
    let mut timeouts: u64 = 0;
    let mut intended: u64 = 0;
    let mut nonce_counter: u64 = 0;
    // Use a plain sleep loop rather than tokio::time::interval — interval's
    // "catch up on missed ticks" behavior would understate latency when the
    // OS throttles the runtime.
    while Instant::now() < deadline {
        nonce_counter = nonce_counter.wrapping_add(1);
        let nonce = nonce_counter;
        intended += 1;

        let (tx, rx) = oneshot::channel::<Instant>();
        {
            let mut p = state.pending.lock().expect("bg_spike pending poisoned");
            p.insert(nonce, tx);
        }

        let t0 = Instant::now();
        // Guard with `if` rather than `||` because the reply hook returns
        // `undefined` (it's a fire-and-forget invoke), and `undefined ||
        // warn(...)` would fire the warning on every successful ping.
        let js = format!(
            "if (window.__bgSpikeReply) {{ window.__bgSpikeReply({nonce}); }} \
             else {{ console.warn('[bg_spike] reply hook not installed — \
             dev/bg-spike.ts should auto-install on dev boot'); }}"
        );
        if let Err(e) = window.eval(&js) {
            log::warn!("[bg_spike] eval failed (nonce={nonce}): {e}");
            state
                .pending
                .lock()
                .expect("pending poisoned")
                .remove(&nonce);
            continue;
        }

        match timeout(per_ping_to, rx).await {
            Ok(Ok(t1)) => {
                let rtt = t1.saturating_duration_since(t0);
                samples_us.push(rtt.as_micros() as u64);
            }
            Ok(Err(_)) => {
                // Sender dropped — should not happen unless state was torn
                // down. Treat as timeout for accounting.
                timeouts += 1;
            }
            Err(_) => {
                state
                    .pending
                    .lock()
                    .expect("pending poisoned")
                    .remove(&nonce);
                timeouts += 1;
            }
        }

        // Sleep the *remainder* of the interval (or skip if we already
        // overran). Keeps cadence honest under high RTT.
        let elapsed = t0.elapsed();
        if elapsed < Duration::from_millis(interval_ms) {
            tokio::time::sleep(Duration::from_millis(interval_ms) - elapsed).await;
        }
    }

    samples_us.sort_unstable();
    let n = samples_us.len();
    let p = |q: f64| -> u64 {
        if n == 0 {
            return 0;
        }
        let idx = ((n as f64) * q).floor() as usize;
        samples_us[idx.min(n - 1)]
    };
    let max_us = *samples_us.last().unwrap_or(&0);
    let p50 = p(0.5);
    let p95 = p(0.95);
    let p99 = p(0.99);
    let trimmed = if samples_us.len() > MAX_SAMPLES_REPORTED {
        // Keep first half as head and last half as tail so the distribution
        // tail (which is what we care about) survives.
        let half = MAX_SAMPLES_REPORTED / 2;
        let mut out = Vec::with_capacity(MAX_SAMPLES_REPORTED);
        out.extend_from_slice(&samples_us[..half]);
        out.extend_from_slice(&samples_us[samples_us.len() - half..]);
        out
    } else {
        samples_us
    };

    Ok(BgSpikeReport {
        intended_count: intended,
        completed_count: n as u64,
        timeout_count: timeouts,
        duration_ms: start.elapsed().as_millis() as u64,
        p50_us: p50,
        p95_us: p95,
        p99_us: p99,
        max_us,
        sample_us: trimmed,
        webview_label: label.to_string(),
    })
}

/// FE-side reply hook calls this with the nonce it received. Lookup +
/// fire is non-blocking; if the nonce is unknown (e.g. the host-side
/// timeout already fired) we silently drop — the host has already
/// accounted for it as a timeout.
#[tauri::command]
pub fn bg_spike_reply(state: State<'_, BgSpikeStateRef>, nonce: u64) {
    let now = Instant::now();
    let maybe_tx = state
        .pending
        .lock()
        .expect("bg_spike pending poisoned")
        .remove(&nonce);
    if let Some(tx) = maybe_tx {
        let _ = tx.send(now);
    }
}
