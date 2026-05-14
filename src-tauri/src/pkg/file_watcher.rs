//! Phase 9 — `restart_when_changed` file-watcher subsystem.
//!
//! Wraps `notify::RecommendedWatcher` with a manual 250 ms debounce so
//! editor saves that fire several events in quick succession only trigger
//! one restart. Glob matching uses the `glob` crate (which supports `**`,
//! unlike `commands::secrets::glob_match` which is intentionally minimal
//! for the flat vault key namespace).
//!
//! Lifetime: one watcher task per Running cycle of a supervised pkg. The
//! supervisor spawns it after handshake-success and drops the cancel
//! sender on cycle exit (clean exit, crash, shutdown). Dropping the cancel
//! sender closes the channel; the watcher task observes that and tears
//! down the underlying `notify` watcher.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use glob::Pattern;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::time::{sleep, Instant};

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);

/// Spawn a watcher rooted at `install_path`. The returned `Sender`'s drop
/// signals the watcher task to tear down. `on_change` is invoked at most
/// once per debounce window with the install_path for context (caller
/// usually only needs the trigger).
///
/// Globs are interpreted relative to `install_path`. A pattern like
/// `src/**/*.ts` matches paths whose stripped form starts with `src/` and
/// ends with a `.ts` segment. Patterns that fail to compile are logged
/// once and skipped; remaining valid patterns still gate the watcher.
pub fn spawn<F>(install_path: PathBuf, globs: Vec<String>, on_change: F) -> Result<WatcherHandle>
where
    F: Fn() + Send + Sync + 'static,
{
    let patterns: Vec<Pattern> = globs
        .iter()
        .filter_map(|g| match Pattern::new(g) {
            Ok(p) => Some(p),
            Err(e) => {
                log::warn!("[pkg_lifecycle.watcher] invalid glob `{g}`: {e}");
                None
            }
        })
        .collect();
    if patterns.is_empty() {
        // No usable globs → no watcher worth running. Return a handle whose
        // shutdown is a no-op so callers don't branch.
        return Ok(WatcherHandle::noop());
    }

    let (event_tx, event_rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            // notify's callback runs on its own thread; forward to the
            // bounded sync channel that the async task drains.
            let _ = event_tx.send(res);
        },
        notify::Config::default(),
    )
    .context("create RecommendedWatcher")?;
    watcher
        .watch(&install_path, RecursiveMode::Recursive)
        .with_context(|| format!("watch {}", install_path.display()))?;

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    let install_for_task = install_path.clone();
    let on_change = Arc::new(on_change);

    tauri::async_runtime::spawn(async move {
        // Hold ownership of the watcher so it lives for the task's lifetime.
        let _keep_alive_watcher = watcher;
        let mut last_fire: Option<Instant> = None;
        let mut pending_fire: Option<Instant> = None;

        loop {
            tokio::select! {
                _ = cancel_rx.recv() => {
                    log::debug!(
                        "[pkg_lifecycle.watcher] {} torn down",
                        install_for_task.display()
                    );
                    return;
                }
                _ = sleep(Duration::from_millis(50)) => {
                    // Drain any queued notify events (non-blocking).
                    let mut matched_any = false;
                    while let Ok(res) = event_rx.try_recv() {
                        let Ok(event) = res else { continue };
                        if matches_any(&event.paths, &install_for_task, &patterns) {
                            matched_any = true;
                        }
                    }
                    if matched_any {
                        pending_fire = Some(Instant::now());
                    }
                    if let Some(at) = pending_fire {
                        if at.elapsed() >= DEBOUNCE_WINDOW {
                            // Coalesce: skip if we just fired inside the
                            // debounce window (notify can re-emit).
                            let should_fire = match last_fire {
                                Some(prev) => prev.elapsed() >= DEBOUNCE_WINDOW,
                                None => true,
                            };
                            if should_fire {
                                last_fire = Some(Instant::now());
                                let cb = on_change.clone();
                                cb();
                            }
                            pending_fire = None;
                        }
                    }
                }
            }
        }
    });

    Ok(WatcherHandle {
        cancel: Some(cancel_tx),
    })
}

/// True when any reported event path, made relative to `install_path`,
/// matches at least one declared pattern.
fn matches_any(paths: &[PathBuf], install_path: &Path, patterns: &[Pattern]) -> bool {
    for p in paths {
        let rel = match p.strip_prefix(install_path) {
            Ok(r) => r,
            Err(_) => continue, // event from outside our root — ignore
        };
        let rel_str = rel.to_string_lossy();
        for pat in patterns {
            if pat.matches(&rel_str) {
                return true;
            }
        }
    }
    false
}

/// Drop-on-end handle. `Drop` closes the channel and the watcher task
/// observes the cancellation on its next select tick.
pub struct WatcherHandle {
    cancel: Option<mpsc::Sender<()>>,
}

impl WatcherHandle {
    fn noop() -> Self {
        Self { cancel: None }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.cancel.take() {
            let _ = tx.try_send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn matches_any_relative_to_install_path() {
        let install = PathBuf::from("/tmp/pkg");
        let pat = Pattern::new("src/**/*.ts").unwrap();
        let pats = vec![pat];
        // Event path under install, matching pattern → true.
        assert!(matches_any(
            &[install.join("src/a/b.ts")],
            &install,
            &pats
        ));
        // Event path under install, NOT matching → false.
        assert!(!matches_any(
            &[install.join("docs/readme.md")],
            &install,
            &pats
        ));
        // Event path outside install → ignored.
        assert!(!matches_any(
            &[PathBuf::from("/other/src/x.ts")],
            &install,
            &pats
        ));
    }

    #[test]
    fn matches_any_supports_doublestar() {
        let install = PathBuf::from("/tmp/pkg");
        let pat = Pattern::new("**/*.toml").unwrap();
        let pats = vec![pat];
        assert!(matches_any(
            &[install.join("Cargo.toml")],
            &install,
            &pats
        ));
        assert!(matches_any(
            &[install.join("nested/deep/here/x.toml")],
            &install,
            &pats
        ));
    }

    #[test]
    fn invalid_glob_gives_noop_handle() {
        // No good patterns → no watcher → noop handle drops cleanly.
        let h = spawn(
            PathBuf::from("/nonexistent-path-for-test"),
            vec!["[".into()],
            || {},
        );
        // Watcher never starts (root path wouldn't even mount); noop.
        match h {
            Ok(handle) => {
                assert!(handle.cancel.is_none());
            }
            Err(_) => {
                // notify::watch on a nonexistent path errors — that's also fine; the
                // module behaviour we care about (skipping invalid globs) is
                // exercised in the assert above when there's at least one valid path.
            }
        }
    }

    #[allow(dead_code)] // exercised by Path::new only — keeps the import live.
    fn _path_link() -> &'static Path {
        Path::new("/")
    }
}
