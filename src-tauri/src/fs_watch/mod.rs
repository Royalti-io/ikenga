//! File-system watcher pool. One `FsWatchManager` instance per app, holding a
//! `DashMap<String, WatcherEntry>` keyed by short uuid (the "watcher id" the
//! frontend sees).
//!
//! Each watcher is a `notify::RecommendedWatcher` running on its own thread.
//! Events get translated to a small JSON-friendly `FileChange` and emitted on
//! `fs://{watcher_id}` so the renderer can hot-reload viewer/storyboard panes.

use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::thread;

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use notify::{event::EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileChange {
    pub kind: ChangeKind,
    pub path: String,
}

struct WatcherEntry {
    /// Holding the watcher keeps it alive; dropping it stops the watch.
    _watcher: RecommendedWatcher,
    /// Signals the forwarder thread to bail.
    stop_tx: std_mpsc::Sender<()>,
}

pub struct FsWatchManager {
    watchers: DashMap<String, WatcherEntry>,
}

impl FsWatchManager {
    pub fn new() -> Self {
        Self {
            watchers: DashMap::new(),
        }
    }

    pub fn watch(&self, app: AppHandle, path: &Path) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let event_name = format!("fs://{id}");

        let (event_tx, event_rx) = std_mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let _ = event_tx.send(res);
            },
        )
        .context("create watcher")?;

        let mode = if path.is_dir() {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        watcher
            .watch(path, mode)
            .with_context(|| format!("watch {}", path.display()))?;

        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();

        let app_for_emit = app.clone();
        thread::spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match event_rx.recv_timeout(std::time::Duration::from_millis(250)) {
                    Ok(Ok(event)) => {
                        let kind = match event.kind {
                            EventKind::Create(_) => Some(ChangeKind::Create),
                            EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                                Some(ChangeKind::Rename)
                            }
                            EventKind::Modify(_) => Some(ChangeKind::Modify),
                            EventKind::Remove(_) => Some(ChangeKind::Remove),
                            _ => None,
                        };
                        if let Some(kind) = kind {
                            for p in event.paths {
                                let change = FileChange {
                                    kind: kind.clone(),
                                    path: p.to_string_lossy().to_string(),
                                };
                                let _ = app_for_emit.emit(&event_name, change);
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        log::debug!("fs watcher error: {e}");
                    }
                    Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        self.watchers.insert(
            id.clone(),
            WatcherEntry {
                _watcher: watcher,
                stop_tx,
            },
        );

        Ok(id)
    }

    pub fn unwatch(&self, id: &str) -> Result<()> {
        match self.watchers.remove(id) {
            Some((_, entry)) => {
                let _ = entry.stop_tx.send(());
                Ok(())
            }
            None => Err(anyhow!("unknown watcher id: {id}")),
        }
    }
}

#[allow(dead_code)]
pub fn canonicalize_for_watch(path: &str) -> Result<PathBuf> {
    let expanded = shellexpand::full(path)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| path.to_string());
    Ok(PathBuf::from(expanded))
}
