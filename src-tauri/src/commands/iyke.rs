//! Iyke Tauri commands. Two surfaces:
//!
//! - `iyke_endpoint` — frontend reads its own port + token to talk to the
//!   Iyke HTTP server (same contract external CLI/MCP callers will use).
//! - `iyke_set_shell` — frontend pushes the current sidebar mode + route
//!   into the Rust-side mirror so the server's `/iyke/state` handler can
//!   answer questions.
//! - `iyke_log_push` / `iyke_network_push` — the FE bridge feeds console
//!   + fetch/XHR captures into ring buffers that `/iyke/logs` and
//!   `/iyke/network` read.
//! - `iyke_dom_done` / `iyke_query_cache_done` / `iyke_wait_done` — FE
//!   callbacks that resolve the matching pending-RPC oneshot. Mirrors
//!   the screenshot_capture_done pattern.

use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tokio::sync::Mutex;

use crate::iyke::handlers::{DomResult, QueryCacheResult, WaitResult};
use crate::iyke::rpc;
use crate::iyke::state::{LogEntry, NetworkEntry};
use crate::iyke::{Endpoint, IykeRpc, IykeRuntime, IykeState};

/// Tauri-managed wrapper around the runtime. `Option` so Drop on app exit
/// fires deterministically when we `take()` it (kept simple for Day 1 by
/// just relying on the natural Drop chain).
pub type IykeRuntimeState = Arc<Mutex<Option<IykeRuntime>>>;

#[tauri::command]
pub async fn iyke_endpoint(runtime: State<'_, IykeRuntimeState>) -> Result<Endpoint, String> {
    let guard = runtime.lock().await;
    match guard.as_ref() {
        Some(rt) => Ok(rt.endpoint()),
        None => Err("iyke runtime not initialized".into()),
    }
}

#[tauri::command]
pub async fn iyke_set_shell(
    state: State<'_, Arc<IykeState>>,
    mode: Option<String>,
    route: Option<String>,
    panes: Option<Value>,
) -> Result<(), String> {
    state.inner().set_shell(mode, route, panes).await;
    Ok(())
}

#[tauri::command]
pub async fn iyke_log_push(
    state: State<'_, Arc<IykeState>>,
    entries: Vec<LogEntry>,
) -> Result<(), String> {
    state.inner().push_logs(entries).await;
    Ok(())
}

#[tauri::command]
pub async fn iyke_network_push(
    state: State<'_, Arc<IykeState>>,
    entries: Vec<NetworkEntry>,
) -> Result<(), String> {
    state.inner().push_network(entries).await;
    Ok(())
}

#[tauri::command]
pub async fn iyke_dom_done(
    rpc_state: State<'_, IykeRpc>,
    request_id: String,
    result: DomResult,
) -> Result<(), String> {
    rpc::resolve(&rpc_state.dom, &request_id, result)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// In-shell DOM-tree probe. Same mechanism as the `/iyke/dom` HTTP
/// endpoint (`iyke::handlers::get_dom`) but exposed as a Tauri command
/// so the Studio's right-rail DOM tab can request a tree of the focused
/// iframe without round-tripping through localhost HTTP.
///
/// `pane` mirrors the HTTP query — Phase A honors "shell" / unset (the
/// main webview); Phase B routes other ids to iframe sidecar bridges.
#[tauri::command]
pub async fn iyke_dom_query(
    app: tauri::AppHandle,
    rpc_state: State<'_, IykeRpc>,
    query: Option<String>,
    all: Option<bool>,
    pane: Option<String>,
) -> Result<DomResult, String> {
    let all_flag = all.unwrap_or(false);
    rpc::request(
        &app,
        &rpc_state.dom,
        "iyke://dom-request",
        std::time::Duration::from_secs(5),
        |request_id| {
            serde_json::json!({
                "request_id": request_id,
                "pane": pane,
                "query": query,
                "all": all_flag,
            })
        },
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn iyke_query_cache_done(
    rpc_state: State<'_, IykeRpc>,
    request_id: String,
    result: QueryCacheResult,
) -> Result<(), String> {
    rpc::resolve(&rpc_state.query_cache, &request_id, result)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn iyke_wait_done(
    rpc_state: State<'_, IykeRpc>,
    request_id: String,
    result: WaitResult,
) -> Result<(), String> {
    rpc::resolve(&rpc_state.wait, &request_id, result)
        .await
        .map_err(|e| format!("{e:#}"))
}
