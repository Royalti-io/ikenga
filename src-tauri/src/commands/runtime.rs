//! Runtime (bun) fetch commands.
//!
//! `runtime_retry_bun_fetch` lets the FE progress chip re-trigger the
//! post-launch bun download after a failure (network blip, transient GitHub
//! error). It re-runs the same `runtime::ensure_bun` flow that the boot-time
//! background task in `lib.rs` runs, emitting `runtime://bun` progress events
//! and waking any sidecars parked as `Blocked{RuntimeNotReady}` on success.
//!
//! Concurrency: a single `AtomicBool` guard prevents two fetches racing (the
//! chip's Retry button and a still-in-flight boot fetch). A second concurrent
//! call is a no-op `Ok(())`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::pkg_mcp::SidecarSupervisorState;
use crate::runtime::{self, BunFetchProgress};

/// Guards against overlapping fetches (boot task + Retry button, or rapid
/// double-clicks). Released on completion via the RAII guard below.
static FETCH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        FETCH_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// Run (or re-run) the bun fetch, emitting `runtime://bun` progress. No-op if a
/// fetch is already running or bun is already ready.
#[tauri::command]
pub async fn runtime_retry_bun_fetch(app: AppHandle) -> Result<(), String> {
    if runtime::bun_ready() {
        let _ = app.emit("runtime://bun", BunFetchProgress::Ready.to_payload());
        return Ok(());
    }
    // Acquire the single-flight guard; bail quietly if one is already running.
    if FETCH_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    let _guard = InFlightGuard;

    let app_for_emit = app.clone();
    let emit = move |p: BunFetchProgress| {
        let _ = app_for_emit.emit("runtime://bun", p.to_payload());
    };

    match runtime::ensure_bun(&app, emit).await {
        Ok(_) => {
            // Wake any bun sidecars parked on RuntimeNotReady.
            if let Some(sup) = app.try_state::<SidecarSupervisorState>() {
                sup.0.wake_runtime_blocked();
            }
            Ok(())
        }
        // `ensure_bun` already emitted the Error progress; surface the message
        // to the FE invoke caller too.
        Err(msg) => Err(msg),
    }
}
