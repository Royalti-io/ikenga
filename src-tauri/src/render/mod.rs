//! Remotion render orchestration.
//!
//! `JobManager` tracks running render jobs by uuid. `start()` spawns
//! `node_modules/.bin/remotion render <composition_id> <output> --props=<json>`
//! from the PA root, pipes stderr through a progress parser, and emits
//! `render://{job_id}` events to the webview.
//!
//! v1 is dev-only — relies on `node_modules/.bin/remotion` being present in
//! `~/royalti-co/ikenga-desktop`. Production packaging (sidecar / bundled
//! Node binary) is deferred per phase 6 plan.

mod process;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::process::Child;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Tagged union sent to the webview on `render://{job_id}`.
///
/// The webview's typed listener mirrors this in `src/lib/tauri-cmd.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenderEvent {
    Started,
    /// `value` ranges 0..=1.
    Progress { value: f64 },
    Log { line: String },
    Complete { output_path: String },
    Error { message: String },
    Cancelled,
}

struct JobHandle {
    /// Holds the spawned child so cancel() can kill it. Wrapped in Mutex so
    /// the spawn task and the cancel command don't race on `kill()`.
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct JobManager {
    jobs: DashMap<String, JobHandle>,
}

impl JobManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a render. Returns the job id immediately; progress + completion
    /// flow through `render://{job_id}` events on the AppHandle.
    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        composition_id: String,
        props: Value,
        output_path: PathBuf,
    ) -> Result<String> {
        let job_id = Uuid::new_v4().to_string();

        let child_slot = Arc::new(Mutex::new(None));
        self.jobs.insert(
            job_id.clone(),
            JobHandle {
                child: child_slot.clone(),
            },
        );

        let manager = self.clone();
        let job_id_for_task = job_id.clone();
        tokio::spawn(async move {
            let result = process::run_render(
                &app,
                &job_id_for_task,
                &composition_id,
                &props,
                &output_path,
                child_slot,
            )
            .await;
            // run_render is responsible for emitting the terminal event
            // (Complete / Error / Cancelled). We just clean up the slot.
            manager.jobs.remove(&job_id_for_task);
            // Surface unexpected errors that escape run_render's own emit
            // path so they don't get silently dropped.
            if let Err(e) = result {
                tracing::error!(job = %job_id_for_task, "render task: {e:#}");
            }
        });

        Ok(job_id)
    }

    /// Kill a running job. Idempotent: missing job ids return Ok.
    pub async fn cancel(&self, job_id: &str) -> Result<()> {
        let Some((_, handle)) = self.jobs.remove(job_id) else {
            return Ok(());
        };
        let mut guard = handle.child.lock().await;
        if let Some(child) = guard.as_mut() {
            child
                .kill()
                .await
                .with_context(|| format!("kill render job {job_id}"))?;
        }
        Ok(())
    }
}

/// Resolve the output_path string against the allowlist + canonicalize.
///
/// Borrowed from `commands::resolve_allowlisted` but inlined here so the
/// render module is self-contained for unit tests.
pub fn validate_output_path(input: &str) -> Result<PathBuf> {
    let resolved = crate::commands::resolve_allowlisted(input)
        .map_err(|e| anyhow!("output path rejected: {e}"))?;
    // Render output must be a file, not a directory; the bundler creates
    // intermediate directories but not the file itself.
    if resolved.is_dir() {
        return Err(anyhow!("output_path is a directory: {}", resolved.display()));
    }
    Ok(resolved)
}
