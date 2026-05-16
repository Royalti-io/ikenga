use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::pty::{foreground::ForegroundProcess, PtyManager, SpawnOpts};

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
    cwd: String,
    cmd: Vec<String>,
    env: Option<HashMap<String, String>>,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    if cmd.is_empty() {
        return Err("cmd must contain at least one element".into());
    }

    let opts = SpawnOpts {
        cwd,
        cmd,
        env: env.unwrap_or_default(),
        rows,
        cols,
    };

    manager
        .spawn(app, opts)
        .await
        .map_err(|e| format!("spawn failed: {e}"))
}

#[tauri::command]
pub async fn pty_write(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager
        .write(&id, data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
pub async fn pty_resize(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager
        .resize(&id, rows, cols)
        .map_err(|e| format!("resize failed: {e}"))
}

#[tauri::command]
pub async fn pty_kill(manager: State<'_, Arc<PtyManager>>, id: String) -> Result<(), String> {
    manager.kill(&id).map_err(|e| format!("kill failed: {e}"))
}

/// Foreground command for a single PTY. Returns `None` when the PTY is gone
/// or the platform can't surface the foreground PG (macOS/Windows in v0).
#[tauri::command]
pub async fn pty_foreground(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
) -> Result<Option<ForegroundProcess>, String> {
    Ok(manager.foreground(&id))
}

/// Foreground snapshot across every live PTY. Used by the routing dispatcher
/// (and the artifact-grid status indicator) to find the active claude
/// session. Keyed by PTY id; PTYs with no observable foreground are omitted.
#[tauri::command]
pub async fn pty_foreground_snapshot(
    manager: State<'_, Arc<PtyManager>>,
) -> Result<HashMap<String, ForegroundProcess>, String> {
    Ok(manager.foreground_snapshot())
}
