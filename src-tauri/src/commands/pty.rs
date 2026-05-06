use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::pty::{PtyManager, SpawnOpts};

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
pub async fn pty_kill(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
) -> Result<(), String> {
    manager
        .kill(&id)
        .map_err(|e| format!("kill failed: {e}"))
}
