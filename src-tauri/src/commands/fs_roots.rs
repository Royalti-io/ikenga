//! Tauri commands for the user-configurable FS allowlist. Every command
//! returns the canonical list so the frontend can sync from the response
//! rather than maintaining a parallel persisted store.

use crate::fs_roots;

fn err_no_state() -> String {
    "fs_roots state not initialized".to_string()
}

#[tauri::command]
pub async fn fs_roots_list() -> Result<Vec<String>, String> {
    let roots = fs_roots::current().ok_or_else(err_no_state)?;
    Ok(roots.list_inputs())
}

#[tauri::command]
pub async fn fs_roots_add(path: String) -> Result<Vec<String>, String> {
    let roots = fs_roots::current().ok_or_else(err_no_state)?;
    roots.add(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_roots_remove(path: String) -> Result<Vec<String>, String> {
    let roots = fs_roots::current().ok_or_else(err_no_state)?;
    roots.remove(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_roots_reset() -> Result<Vec<String>, String> {
    let roots = fs_roots::current().ok_or_else(err_no_state)?;
    roots.reset().map_err(|e| e.to_string())
}
