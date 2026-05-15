//! Tauri command surface for the per-pkg child-webview kernel.
//!
//! Thin wrappers around `pkg::webview::WebviewPanesRegistry` methods. Each
//! command takes a `keep_awake::InflightGuard` at the top so the macOS App-Nap
//! and Windows WebView2 visibility mitigations are in effect for the duration
//! of the call (defensive — Linux is a no-op).
//!
//! Parameters use camelCase across the IPC boundary (FE consumes via
//! `pkgWebviewCreate / Destroy / Navigate / SetRect` in `tauri-cmd.ts`).
//! `eval` is intentionally NOT exposed to the frontend — only the kernel
//! and pkg-MCP servers ever drive it; FE-side use would defeat the whole
//! sandboxing model.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::pkg::keep_awake;
use crate::pkg::webview::{PaneRect, WebviewPanesRegistry};

pub struct WebviewPanesState(pub Arc<WebviewPanesRegistry>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgWebviewCreateResult {
    /// Opaque kernel-assigned label for the webview (`pkg-<slug>-<pane>`).
    /// FE doesn't need this for normal operation; surfaced for debugging.
    pub webview_label: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pkg_webview_create(
    app: AppHandle,
    state: State<'_, WebviewPanesState>,
    pkg_id: String,
    pane_id: String,
    url: String,
    rect: PaneRect,
    partition: Option<String>,
) -> Result<PkgWebviewCreateResult, String> {
    let _guard = keep_awake::acquire("ikenga pkg_webview_create");
    let webview_label = state
        .0
        .create(&app, &pkg_id, &pane_id, &url, rect, partition.as_deref())
        .map_err(|e| format!("{e:#}"))?;
    Ok(PkgWebviewCreateResult { webview_label })
}

#[tauri::command]
pub async fn pkg_webview_destroy(
    state: State<'_, WebviewPanesState>,
    pkg_id: String,
    pane_id: String,
) -> Result<(), String> {
    // No keep-awake on destroy — teardown should never need to inhibit App Nap.
    state
        .0
        .destroy(&pkg_id, &pane_id)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pkg_webview_navigate(
    state: State<'_, WebviewPanesState>,
    pkg_id: String,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    let _guard = keep_awake::acquire("ikenga pkg_webview_navigate");
    state
        .0
        .navigate(&pkg_id, &pane_id, &url)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pkg_webview_set_rect(
    state: State<'_, WebviewPanesState>,
    pkg_id: String,
    pane_id: String,
    rect: PaneRect,
) -> Result<(), String> {
    // No keep-awake on rect changes — typically fired during resize, which
    // by definition means the window is in focus.
    state
        .0
        .set_rect(&pkg_id, &pane_id, rect)
        .map_err(|e| format!("{e:#}"))
}
