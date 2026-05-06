//! Viewer commands: spin up an axum static-file server bound to a random
//! ephemeral port on localhost, return `(url, token)` to the frontend. The
//! `rootDir` is allowlist-checked.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::commands::resolve_allowlisted;
use crate::viewer_server::ViewerServerManager;

#[derive(Serialize)]
pub struct ViewerHandle {
    pub url: String,
    pub token: String,
}

#[tauri::command]
pub async fn viewer_serve(
    manager: State<'_, Arc<ViewerServerManager>>,
    #[allow(non_snake_case)] rootDir: String,
) -> Result<ViewerHandle, String> {
    let resolved = resolve_allowlisted(&rootDir).map_err(|e| e.to_string())?;
    if !resolved.is_dir() {
        return Err(format!("not a directory: {}", resolved.display()));
    }
    let mgr = manager.inner().clone();
    let (url, token) = mgr
        .serve(resolved)
        .await
        .map_err(|e| format!("viewer serve failed: {e}"))?;
    Ok(ViewerHandle { url, token })
}

#[tauri::command]
pub async fn viewer_stop(
    manager: State<'_, Arc<ViewerServerManager>>,
    token: String,
) -> Result<(), String> {
    manager
        .stop(&token)
        .map_err(|e| format!("viewer stop failed: {e}"))
}
