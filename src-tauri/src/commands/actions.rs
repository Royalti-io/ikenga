//! pa-actions sidecar bridge.
//!
//! Spawns the bundled `pa-actions` binary in one-shot mode, sends the
//! subcommand + args, collects the single JSON outcome line. For higher
//! throughput we could move to daemon mode (start once, reuse), but the
//! one-shot model keeps the lifecycle dead-simple and the binary boots in
//! ~50ms — fine for user-triggered "Refresh now" buttons and the rare
//! mutation.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::time::timeout;

use crate::sidecar::spawn_sidecar;

const SIDECAR_NAME: &str = "ikenga-actions";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize)]
pub struct ActionOutcome {
    pub ok: bool,
    pub subcommand: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Run a pa-actions subcommand. `triggered_by` is propagated so the
/// observability log distinguishes desktop refreshes from cron firings.
#[tauri::command]
pub async fn pa_actions_run(
    _app: AppHandle,
    subcommand: String,
    args: Option<Vec<String>>,
) -> Result<ActionOutcome, String> {
    let mut argv: Vec<String> = vec![subcommand.clone()];
    if let Some(extra) = args {
        argv.extend(extra);
    }
    argv.push("--triggered-by".into());
    argv.push("desktop".into());

    let mut child = spawn_sidecar(SIDECAR_NAME, &argv)
        .await
        .map_err(|e| format!("spawn sidecar {SIDECAR_NAME}: {e:#}"))?;

    // Drain stderr concurrently so the OS pipe never fills.
    if let Some(mut stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(line)) = stderr.next_line().await {
                tracing::debug!(target: "ikenga-actions", "{}", line);
            }
        });
    }

    // The actions sidecar prints its outcome as the LAST stdout line; we
    // keep overwriting `last_line` until EOF so transient progress logs
    // before the final JSON don't matter.
    let mut last_line: Option<String> = None;

    let result = timeout(DEFAULT_TIMEOUT, async {
        while let Ok(Some(line)) = child.stdout.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            last_line = Some(trimmed.to_string());
        }
        Ok::<(), String>(())
    })
    .await;

    match result {
        Err(_) => Err("pa-actions sidecar timed out".into()),
        Ok(Err(e)) => Err(e),
        Ok(Ok(())) => match last_line {
            None => Err("pa-actions emitted no outcome".into()),
            Some(line) => serde_json::from_str::<ActionOutcome>(&line)
                .map_err(|e| format!("parse outcome ({e}): {line}")),
        },
    }
}
