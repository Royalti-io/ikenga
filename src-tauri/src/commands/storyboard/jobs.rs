//! Storyboard job manager — long-running ops (render-still, promote-rung).
//!
//! Mirrors `crate::render::JobManager` shape so the FE can reuse query
//! patterns. Status flows through `storyboard_jobs` rows in SQLite (created
//! by the FE before invoking) and `storyboard://{job_id}` events emitted to
//! the webview as the op progresses.

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoryboardJobEvent {
    Started,
    /// 0..1 for whole-job progress (e.g. beat N of M during promote-rung).
    Progress { value: f64 },
    Log { line: String },
    /// A still finished writing. UI uses this to refresh the beat row.
    StillReady {
        beat_id: String,
        rung: String,
        still_path: String,
    },
    Complete,
    Error { message: String },
    Cancelled,
}

pub struct JobHandle {
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct StoryboardJobManager {
    pub jobs: DashMap<String, JobHandle>,
}

impl StoryboardJobManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, job_id: &str, child_slot: Arc<Mutex<Option<Child>>>) {
        self.jobs.insert(
            job_id.to_string(),
            JobHandle { child: child_slot },
        );
    }

    pub fn forget(&self, job_id: &str) {
        self.jobs.remove(job_id);
    }
}

pub type StoryboardJobManagerState = Arc<StoryboardJobManager>;

/// Helper to emit on the per-job topic. Safe to call from any task.
pub fn emit_event(app: &AppHandle, job_id: &str, event: StoryboardJobEvent) {
    let topic = format!("storyboard://{job_id}");
    if let Err(e) = app.emit(&topic, event) {
        tracing::warn!(job = %job_id, "storyboard emit failed: {e}");
    }
}
