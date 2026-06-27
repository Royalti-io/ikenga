//! Tauri command surface for the multi-window substrate (plans/multi-window
//! WP-03). Thin wrappers over `window::WindowRegistry`. Mirrored by the typed
//! wrappers in `src/lib/tauri-cmd.ts`.

use tauri::{AppHandle, State};

use crate::window::descriptor::WindowDescriptor;
use crate::window::registry::WindowRegistry;

/// Spawn a labeled window from a descriptor. Returns the window label.
#[tauri::command]
pub fn window_spawn(
    app: AppHandle,
    registry: State<'_, WindowRegistry>,
    descriptor: WindowDescriptor,
) -> Result<String, String> {
    registry.spawn(&app, descriptor).map_err(|e| e.to_string())
}

/// Close a spawned window by label (`main` is refused).
#[tauri::command]
pub fn window_close(
    app: AppHandle,
    registry: State<'_, WindowRegistry>,
    label: String,
) -> Result<(), String> {
    registry.close(&app, &label).map_err(|e| e.to_string())
}

/// List descriptors of all currently-spawned windows.
#[tauri::command]
pub fn window_list(registry: State<'_, WindowRegistry>) -> Vec<WindowDescriptor> {
    registry.list()
}
