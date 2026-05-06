//! Remotion render commands. Day 3 of phase 6 wires the JobManager into
//! Tauri so the webview can trigger renders and listen for progress.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::render::{validate_output_path, JobManager};

pub type JobManagerState = Arc<JobManager>;

#[tauri::command]
pub async fn render_composition(
    app: AppHandle,
    manager: State<'_, JobManagerState>,
    #[allow(non_snake_case)] compositionId: String,
    props: Value,
    output: String,
) -> Result<String, String> {
    let resolved_output =
        validate_output_path(&output).map_err(|e| format!("output: {e:#}"))?;

    let manager = manager.inner().clone();
    manager
        .start(app, compositionId, props, resolved_output)
        .map_err(|e| format!("start render: {e:#}"))
}

#[tauri::command]
pub async fn render_cancel(
    manager: State<'_, JobManagerState>,
    #[allow(non_snake_case)] jobId: String,
) -> Result<(), String> {
    manager
        .inner()
        .cancel(&jobId)
        .await
        .map_err(|e| format!("cancel render: {e:#}"))
}
