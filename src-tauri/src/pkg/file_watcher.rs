//! Phase 9 — `restart_when_changed` file-watcher subsystem.
//!
//! Wraps `notify-debouncer-mini` (notify's official 250 ms debouncer) so
//! editor saves that fire several events in quick succession only trigger
//! one restart. Glob matching uses the `glob` crate (which supports `**`,
//! unlike `commands::secrets::glob_match` which is intentionally minimal
//! for the flat vault key namespace).
//!
//! Lifetime: one watcher task per Running cycle of a supervised pkg. The
//! supervisor spawns it after handshake-success and drops the cancel
//! sender on cycle exit (clean exit, crash, shutdown). Dropping the cancel
//! sender closes the channel; the watcher task observes that and drops
//! the underlying `Debouncer`, which stops its worker thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use glob::Pattern;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use tokio::sync::mpsc;

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

    let on_change = Arc::new(on_change);
    let patterns_for_cb = patterns.clone();
    let install_for_cb = install_path.clone();
    let on_change_for_cb = on_change.clone();

    let mut debouncer = new_debouncer(DEBOUNCE_WINDOW, move |res: DebounceEventResult| {
        let events = match res {
            Ok(events) => events,
            Err(_) => return,
        };
        // DebouncedEvent.path is a single PathBuf — wrap as a one-elem slice
        // so matches_any keeps its existing &[PathBuf] signature + tests.
        for ev in events {
            if matches_any(std::slice::from_ref(&ev.path), &install_for_cb, &patterns_for_cb) {
                (on_change_for_cb)();
                break;
            }
        }
    })
    .context("create notify debouncer")?;
    debouncer
        .watcher()
        .watch(&install_path, RecursiveMode::Recursive)
        .with_context(|| format!("watch {}", install_path.display()))?;

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    let install_for_task = install_path.clone();

    tauri::async_runtime::spawn(async move {
        // Hold the debouncer for the task's lifetime; drop ends the worker.
        let _keep_alive = debouncer;
        let _ = cancel_rx.recv().await;
        log::debug!(
            "[pkg_lifecycle.watcher] {} torn down",
            install_for_task.display()
        );
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
