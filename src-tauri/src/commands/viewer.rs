//! Viewer commands: register a `(token, root)` mount in the shared
//! viewer-server's registry and return a shell-origin-relative URL prefix.
//! The actual server is bound once at startup (see
//! `ViewerServerManager::start` in `lib.rs`); commands here are just
//! mount-registry edits.
//!
//! `rootDir` is allowlist-checked.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::commands::resolve_allowlisted;
use crate::viewer_server::ViewerServerManager;

#[derive(Serialize)]
pub struct ViewerHandle {
    /// Shell-origin-relative URL prefix, e.g. `/__viewer/<token>/`.
    /// FE appends the file path (resolved against the viewer mount root).
    pub url: String,
    /// 32-byte hex token; pass back to `viewer_stop` to release the mount.
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
    let (url, token) = manager.register(resolved);
    Ok(ViewerHandle { url, token })
}

#[tauri::command]
pub async fn viewer_stop(
    manager: State<'_, Arc<ViewerServerManager>>,
    token: String,
) -> Result<(), String> {
    manager.unregister(&token);
    Ok(())
}

/// Bound port of the shared viewer server. Returned to the FE so dev mode
/// (Vite shell origin) can build absolute URLs when the proxy isn't wired,
/// and so prod (localhost-plugin) can confirm the port matches.
#[tauri::command]
pub async fn viewer_port(
    manager: State<'_, Arc<ViewerServerManager>>,
) -> Result<Option<u16>, String> {
    Ok(manager.bound_port())
}
