//! HTTP handlers for the Iyke server.
//!
//! Read side: `GET /iyke/state` returns the shell snapshot the FE has
//! pushed via `iyke_set_shell`.
//!
//! Write side (Phase 11 Day 2/3): `POST /iyke/{go,mode,open,split,focus,close}`
//! validate their bodies and emit a typed Tauri event. A FE listener
//! mounted in `<Workspace />` translates events into `usePaneStore` /
//! `useShellStore` mutations. Handlers return 200 immediately — think
//! "command accepted" rather than "command executed". Empirical latency
//! is sub-frame, so callers don't notice.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Json as JsonBody, Query},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalSize, Manager};

use super::rpc;
use super::state::{IykeState, LogEntry, NetworkEntry};
use super::IykeRpc;

const DOM_TIMEOUT: Duration = Duration::from_secs(5);
const QUERY_CACHE_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_TIMEOUT_DEFAULT_MS: u64 = 10_000;
const WAIT_TIMEOUT_MAX_MS: u64 = 60_000;

// --- types shared with the IykeRpc bundle ---------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomResult {
    /// Plaintext snapshot in Playwright-style accessibility tree format.
    pub text: String,
    /// Same tree as structured JSON (array of { role, name, ref, value, children }).
    pub json: Value,
    /// Snapshot generation. FE bumps it each time so callers can detect
    /// stale refs. Echoed in click/type/key responses.
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryCacheResult {
    /// Array of { queryKey, status, dataUpdatedAt, errorUpdatedAt, fetchStatus,
    ///            isStale, error?, dataPreview? }.
    pub entries: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitResult {
    pub satisfied: bool,
    pub elapsed_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct StateResponse {
    pub schema_version: u32,
    pub app: AppInfo,
    pub shell: ShellInfo,
}

#[derive(Serialize)]
pub struct AppInfo {
    pub pid: u32,
    pub started_at_unix_ms: u128,
    pub identifier: &'static str,
}

#[derive(Serialize)]
pub struct ShellInfo {
    pub mode: Option<String>,
    pub route: Option<String>,
    /// Phase 12: opaque pane-tree blob pushed by the FE. `null` when the
    /// FE hasn't pushed anything yet. See
    /// `ikenga-desktop/src/lib/iyke/use-iyke-shell-sync.ts` for the
    /// schema (`{ leaves: [...], tree }`).
    pub panes: Option<Value>,
}

pub async fn get_state(Extension(state): Extension<Arc<IykeState>>) -> Json<StateResponse> {
    let shell = state.snapshot().await;
    Json(StateResponse {
        schema_version: 1,
        app: AppInfo {
            pid: state.pid(),
            started_at_unix_ms: state.started_at_unix_ms(),
            identifier: "app.ikenga",
        },
        shell: ShellInfo {
            mode: shell.mode,
            route: shell.route,
            panes: shell.panes,
        },
    })
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

fn ok() -> Json<OkResponse> {
    Json(OkResponse { ok: true })
}

// --- write-side bodies ----------------------------------------------------

#[derive(Deserialize)]
pub struct GoBody {
    pub path: String,
}

#[derive(Deserialize)]
pub struct ModeBody {
    pub mode: String,
}

#[derive(Deserialize)]
pub struct SplitBody {
    pub direction: String,
    #[serde(default)]
    pub pane_id: Option<String>,
}

#[derive(Deserialize)]
pub struct FocusBody {
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub index: Option<u32>,
}

#[derive(Deserialize)]
pub struct CloseBody {
    #[serde(default)]
    pub pane_id: Option<String>,
}

/// Window resize. Either supply `width` + `height` (logical pixels) for an
/// explicit size, or `preset` for a window-manager state change.
#[derive(Deserialize)]
pub struct ResizeBody {
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// One of: maximize, unmaximize, fullscreen, unfullscreen, minimize.
    #[serde(default)]
    pub preset: Option<String>,
}

// --- handlers -------------------------------------------------------------

pub async fn post_go(
    Extension(app): Extension<AppHandle>,
    Extension(state): Extension<Arc<IykeState>>,
    JsonBody(body): JsonBody<GoBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if !body.path.starts_with('/') {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("path must start with '/', got {:?}", body.path),
        ));
    }
    // Update the Rust mirror eagerly so a follow-up GET /iyke/state sees
    // the new route even if the FE listener hasn't run yet.
    state.set_shell(None, Some(body.path.clone()), None).await;
    emit(&app, "iyke:go", serde_json::json!({ "path": body.path }))?;
    Ok(ok())
}

pub async fn post_mode(
    Extension(app): Extension<AppHandle>,
    Extension(state): Extension<Arc<IykeState>>,
    JsonBody(body): JsonBody<ModeBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if !is_valid_mode(&body.mode) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("invalid mode: {:?}", body.mode),
        ));
    }
    state.set_shell(Some(body.mode.clone()), None, None).await;
    emit(&app, "iyke:mode", serde_json::json!({ "mode": body.mode }))?;
    Ok(ok())
}

/// `/iyke/open` accepts a free-form body to keep the wire surface small.
/// The FE listener does the actual validation against its `PaneView`
/// union — that way new view kinds can land FE-only without touching
/// the Rust side. We only sanity-check that `kind` is one we recognize.
pub async fn post_open(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    let kind = body
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "missing field: kind".into()))?;
    if !matches!(
        kind,
        "route" | "terminal" | "chat" | "artifact" | "mini-app"
    ) {
        return Err((StatusCode::BAD_REQUEST, format!("invalid kind: {kind:?}")));
    }
    emit(&app, "iyke:open", body)?;
    Ok(ok())
}

pub async fn post_split(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<SplitBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if !matches!(body.direction.as_str(), "horizontal" | "vertical") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "direction must be 'horizontal' or 'vertical', got {:?}",
                body.direction
            ),
        ));
    }
    emit(
        &app,
        "iyke:split",
        serde_json::json!({
            "direction": body.direction,
            "pane_id": body.pane_id,
        }),
    )?;
    Ok(ok())
}

pub async fn post_focus(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<FocusBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if body.pane_id.is_none() && body.index.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "must provide one of: pane_id, index".into(),
        ));
    }
    emit(
        &app,
        "iyke:focus",
        serde_json::json!({
            "pane_id": body.pane_id,
            "index": body.index,
        }),
    )?;
    Ok(ok())
}

pub async fn post_close(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<CloseBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    emit(
        &app,
        "iyke:close",
        serde_json::json!({ "pane_id": body.pane_id }),
    )?;
    Ok(ok())
}

#[derive(Deserialize)]
pub struct RefreshBody {
    #[serde(default)]
    pub pane_id: Option<String>,
}

pub async fn post_refresh(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<RefreshBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    emit(
        &app,
        "iyke:refresh",
        serde_json::json!({ "pane_id": body.pane_id }),
    )?;
    Ok(ok())
}

/// Resize / maximize / fullscreen the main window. Unlike the pane verbs
/// this doesn't round-trip through the FE — Tauri exposes the webview
/// window directly so we drive it from the Rust side.
pub async fn post_resize(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<ResizeBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    let window = app.get_webview_window("main").ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "main window not found".into(),
    ))?;

    if let Some(preset) = body.preset.as_deref() {
        let map = |e: tauri::Error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("window op failed: {e}"),
            )
        };
        match preset {
            "maximize" => window.maximize().map_err(map)?,
            "unmaximize" => window.unmaximize().map_err(map)?,
            "fullscreen" => window.set_fullscreen(true).map_err(map)?,
            "unfullscreen" => window.set_fullscreen(false).map_err(map)?,
            "minimize" => window.minimize().map_err(map)?,
            other => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("unknown preset: {other:?}"),
                ));
            }
        }
        return Ok(ok());
    }

    let (w, h) = match (body.width, body.height) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "must provide preset or width+height".into(),
            ));
        }
    };
    if !(200..=10_000).contains(&w) || !(200..=10_000).contains(&h) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("width/height out of range: {w}x{h} (allowed 200..=10000)"),
        ));
    }
    window
        .set_size(LogicalSize::new(w as f64, h as f64))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("set_size failed: {e}"),
            )
        })?;
    Ok(ok())
}

// --- screenshot ------------------------------------------------------------

#[derive(Deserialize)]
pub struct ScreenshotBody {
    #[serde(default)]
    pub out_path: Option<String>,
    /// Required when hitting `/iyke/screenshot/pane`; ignored on the window
    /// route.
    #[serde(default)]
    pub pane_id: Option<String>,
}

/// RPC-shaped: unlike the pane-verb handlers above, screenshot routes await
/// the full FE round-trip and return the saved file path. Callers (CLI, MCP)
/// need the path back, fire-and-forget doesn't help them.
pub async fn post_screenshot_window(
    Extension(app): Extension<AppHandle>,
    Extension(pending): Extension<crate::commands::ScreenshotPending>,
    JsonBody(body): JsonBody<ScreenshotBody>,
) -> Result<Json<crate::commands::ScreenshotResult>, (StatusCode, String)> {
    let result = crate::commands::screenshot::capture(
        &app,
        &pending,
        crate::commands::screenshot::ScreenshotKind::Window,
        None,
        body.out_path,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(result))
}

pub async fn post_screenshot_pane(
    Extension(app): Extension<AppHandle>,
    Extension(pending): Extension<crate::commands::ScreenshotPending>,
    JsonBody(body): JsonBody<ScreenshotBody>,
) -> Result<Json<crate::commands::ScreenshotResult>, (StatusCode, String)> {
    let pane_id = body
        .pane_id
        .as_deref()
        .ok_or((StatusCode::BAD_REQUEST, "missing field: pane_id".into()))?;
    let result = crate::commands::screenshot::capture(
        &app,
        &pending,
        crate::commands::screenshot::ScreenshotKind::Pane,
        Some(pane_id),
        body.out_path,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(result))
}

// --- DOM / accessibility-tree snapshot ------------------------------------

#[derive(Deserialize)]
pub struct DomQuery {
    /// Substring filter against the role/name/value of each entry.
    /// Case-insensitive. None returns the full tree.
    #[serde(default)]
    pub query: Option<String>,
    /// `false` (default) drops aria-hidden + display:none + visibility:hidden
    /// + 0-size nodes. `true` keeps them.
    #[serde(default)]
    pub all: bool,
    /// Pane id. Phase A only honors "shell" / unset (the main webview);
    /// Phase B routes other ids to iframe sidecar bridges.
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn get_dom(
    Extension(app): Extension<AppHandle>,
    Extension(rpc): Extension<IykeRpc>,
    Query(q): Query<DomQuery>,
) -> Result<Json<DomResult>, (StatusCode, String)> {
    let pane = q.pane.clone();
    let query = q.query.clone();
    let all = q.all;
    let result = rpc::request(
        &app,
        &rpc.dom,
        "iyke://dom-request",
        DOM_TIMEOUT,
        |request_id| {
            serde_json::json!({
                "request_id": request_id,
                "pane": pane,
                "query": query,
                "all": all,
            })
        },
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(result))
}

// --- query-cache dump -----------------------------------------------------

#[derive(Deserialize)]
pub struct QueryCacheQuery {
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn get_query_cache(
    Extension(app): Extension<AppHandle>,
    Extension(rpc): Extension<IykeRpc>,
    Query(q): Query<QueryCacheQuery>,
) -> Result<Json<QueryCacheResult>, (StatusCode, String)> {
    let pane = q.pane.clone();
    let result = rpc::request(
        &app,
        &rpc.query_cache,
        "iyke://query-cache-request",
        QUERY_CACHE_TIMEOUT,
        |request_id| {
            serde_json::json!({
                "request_id": request_id,
                "pane": pane,
            })
        },
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(result))
}

// --- wait -----------------------------------------------------------------

#[derive(Deserialize)]
pub struct WaitBody {
    /// One of: "text", "selector", "ref", "gone-text", "gone-selector".
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn post_wait(
    Extension(app): Extension<AppHandle>,
    Extension(rpc): Extension<IykeRpc>,
    JsonBody(body): JsonBody<WaitBody>,
) -> Result<Json<WaitResult>, (StatusCode, String)> {
    if !matches!(
        body.kind.as_str(),
        "text" | "selector" | "ref" | "gone-text" | "gone-selector"
    ) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("unknown wait kind: {:?}", body.kind),
        ));
    }
    let timeout_ms = body
        .timeout_ms
        .unwrap_or(WAIT_TIMEOUT_DEFAULT_MS)
        .min(WAIT_TIMEOUT_MAX_MS);
    let kind = body.kind.clone();
    let value = body.value.clone();
    let pane = body.pane.clone();

    // Bridge polls until satisfied / timed out, then resolves. Use the
    // wall timeout + 1s slack so the rpc::request timeout doesn't
    // pre-empt a legitimate timeout response.
    let rpc_timeout = Duration::from_millis(timeout_ms + 1000);
    let result = rpc::request(
        &app,
        &rpc.wait,
        "iyke://wait-request",
        rpc_timeout,
        |request_id| {
            serde_json::json!({
                "request_id": request_id,
                "kind": kind,
                "value": value,
                "timeout_ms": timeout_ms,
                "pane": pane,
            })
        },
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(result))
}

// --- click / type / key (fire-and-forget) ---------------------------------

#[derive(Deserialize)]
pub struct ClickBody {
    /// One of: ref, selector, text. Exactly one of (ref|selector|text)
    /// must be set.
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn post_click(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<ClickBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    require_one_target(&body.r#ref, &body.selector, &body.text)?;
    emit(
        &app,
        "iyke://click",
        serde_json::json!({
            "ref": body.r#ref,
            "selector": body.selector,
            "text": body.text,
            "pane": body.pane,
        }),
    )?;
    Ok(ok())
}

#[derive(Deserialize)]
pub struct TypeBody {
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    pub text: String,
    /// If true, replace the current value. Default appends.
    #[serde(default)]
    pub replace: bool,
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn post_type(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<TypeBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    require_one_target(&body.r#ref, &body.selector, &None)?;
    emit(
        &app,
        "iyke://type",
        serde_json::json!({
            "ref": body.r#ref,
            "selector": body.selector,
            "text": body.text,
            "replace": body.replace,
            "pane": body.pane,
        }),
    )?;
    Ok(ok())
}

#[derive(Deserialize)]
pub struct KeyBody {
    /// Comma- or plus-separated combo, e.g. "Enter", "Ctrl+S", "Meta+K".
    pub combo: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub pane: Option<String>,
}

pub async fn post_key(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<KeyBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if body.combo.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "combo must not be empty".into()));
    }
    emit(
        &app,
        "iyke://key",
        serde_json::json!({
            "combo": body.combo,
            "ref": body.r#ref,
            "selector": body.selector,
            "pane": body.pane,
        }),
    )?;
    Ok(ok())
}

fn require_one_target(
    r#ref: &Option<String>,
    selector: &Option<String>,
    text: &Option<String>,
) -> Result<(), (StatusCode, String)> {
    let count = r#ref.is_some() as u8 + selector.is_some() as u8 + text.is_some() as u8;
    if count != 1 {
        return Err((
            StatusCode::BAD_REQUEST,
            "must set exactly one of: ref, selector, text".into(),
        ));
    }
    Ok(())
}

// --- logs / network reads -------------------------------------------------

#[derive(Deserialize)]
pub struct LogsQuery {
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub since: Option<u128>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Serialize)]
pub struct LogsResponse {
    pub entries: Vec<LogEntry>,
}

pub async fn get_logs(
    Extension(state): Extension<Arc<IykeState>>,
    Query(q): Query<LogsQuery>,
) -> Json<LogsResponse> {
    let entries = state
        .recent_logs(q.level.as_deref(), q.since, q.source.as_deref())
        .await;
    Json(LogsResponse { entries })
}

#[derive(Deserialize)]
pub struct NetworkQuery {
    #[serde(default)]
    pub since: Option<u128>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Serialize)]
pub struct NetworkResponse {
    pub entries: Vec<NetworkEntry>,
}

pub async fn get_network(
    Extension(state): Extension<Arc<IykeState>>,
    Query(q): Query<NetworkQuery>,
) -> Json<NetworkResponse> {
    let entries = state.recent_network(q.since, q.source.as_deref()).await;
    Json(NetworkResponse { entries })
}

// --- iframe state + message (Phase C) -------------------------------------

#[derive(Deserialize)]
pub struct IframeStateQuery {
    pub pane: String,
}

/// Read the latest published state object for an iframe pane. The FE
/// piggy-backs the answer on the same Pending<DomResult> channel: the
/// state object goes in `json`, generation tracks the registry version.
pub async fn get_iframe_state(
    Extension(app): Extension<AppHandle>,
    Extension(rpc): Extension<IykeRpc>,
    Query(q): Query<IframeStateQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pane = q.pane.clone();
    let result = rpc::request(
        &app,
        &rpc.dom,
        "iyke://iframe-state-request",
        Duration::from_secs(2),
        |request_id| {
            serde_json::json!({
                "request_id": request_id,
                "pane": pane,
            })
        },
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::json!({
        "pane": q.pane,
        "state": result.json,
        "generation": result.generation,
    })))
}

#[derive(Deserialize)]
pub struct IframeMessageBody {
    pub pane: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Option<Value>,
}

pub async fn post_iframe_message(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<IframeMessageBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if body.kind.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "kind must not be empty".into()));
    }
    emit(
        &app,
        "iyke://iframe-message",
        serde_json::json!({
            "pane": body.pane,
            "kind": body.kind,
            "payload": body.payload,
        }),
    )?;
    Ok(ok())
}

// --- devtools -------------------------------------------------------------

#[derive(Deserialize)]
pub struct PkgInstallBody {
    pub install_path: String,
    /// Phase 2 (projects-first-class): scope picker.
    /// `"workspace"` / `"project:<id>"` / null (defaults to active project).
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Deserialize)]
pub struct PkgUninstallBody {
    pub pkg_id: String,
}

pub async fn post_pkg_uninstall(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<PkgUninstallBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    use tauri::Manager;
    let kernel = app.try_state::<crate::commands::KernelState>().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "pkg kernel state not registered".into(),
    ))?;
    let kernel_arc = kernel.0.clone();
    let pkg_id = body.pkg_id;
    tokio::task::spawn_blocking(move || kernel_arc.uninstall(&pkg_id))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("join error: {e}"),
            )
        })?
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    Ok(ok())
}

#[derive(serde::Deserialize)]
pub struct PkgListQuery {
    /// When true, return pkgs scoped to other projects too. Default false.
    #[serde(default)]
    pub include_other_projects: bool,
    /// "workspace" → only workspace-scoped, "project" → only project-scoped.
    pub kind: Option<String>,
}

/// Phase 2 (projects-first-class) bridge endpoint: list installed pkgs
/// with scope-aware filtering. Default returns workspace + active-project
/// pkgs; pass `include_other_projects=true` to include the rest.
pub async fn get_pkg_list(
    Extension(app): Extension<AppHandle>,
    Extension(db): Extension<Arc<crate::commands::db::PaDb>>,
    axum::extract::Query(q): axum::extract::Query<PkgListQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    use tauri::Manager;
    let kernel = app.try_state::<crate::commands::KernelState>().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "pkg kernel state not registered".into(),
    ))?;
    let active = {
        let pool = db
            .ensure_pool()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        crate::commands::projects::get_active_project_id(&pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    let mut entries: Vec<Value> = Vec::new();
    for s in kernel.0.list_installed() {
        let kind_match = match q.kind.as_deref() {
            Some("workspace") => s.project_id.is_none(),
            Some("project") => s.project_id.is_some(),
            _ => true,
        };
        if !kind_match {
            continue;
        }
        let visible = match &s.project_id {
            None => true,
            Some(p) => p == &active,
        };
        if !visible && !q.include_other_projects {
            continue;
        }
        let scope_wire = match &s.project_id {
            None => "workspace".to_string(),
            Some(p) => format!("project:{p}"),
        };
        entries.push(serde_json::json!({
            "id": s.id,
            "version": s.version,
            "ikenga_api": s.ikenga_api,
            "install_path": s.install_path,
            "enabled": s.enabled,
            "installed_at": s.installed_at,
            "compatible": s.compatible,
            "source": s.source,
            "scope": scope_wire,
            "active_now": visible,
        }));
    }
    Ok(Json(serde_json::json!({
        "active_project_id": active,
        "pkgs": entries,
    })))
}

#[derive(Deserialize)]
pub struct PkgScopeSetBody {
    pub pkg_id: String,
    /// "workspace" | "project:<id>" | null (defaults to active project).
    pub scope: Option<String>,
}

pub async fn post_pkg_scope_set(
    Extension(app): Extension<AppHandle>,
    Extension(db): Extension<Arc<crate::commands::db::PaDb>>,
    JsonBody(body): JsonBody<PkgScopeSetBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    use tauri::Manager;
    let kernel = app.try_state::<crate::commands::KernelState>().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "pkg kernel state not registered".into(),
    ))?;
    let project_id = crate::commands::pkg::resolve_install_scope_for_iyke(db.clone(), body.scope)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let active = crate::commands::projects::get_active_project_id(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let kernel_arc = kernel.0.clone();
    let pkg_id = body.pkg_id.clone();
    let active_for_task = active.clone();
    let project_for_task = project_id.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        kernel_arc
            .set_scope(&pkg_id, project_for_task)
            .map_err(|e| format!("{e:#}"))?;
        kernel_arc
            .reconcile_for_project(&active_for_task)
            .map_err(|e| format!("{e:#}"))?;
        Ok(())
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("join error: {e}"),
        )
    })?
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(ok())
}

pub async fn post_pkg_install(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<PkgInstallBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    use tauri::Manager;
    let kernel = app.try_state::<crate::commands::KernelState>().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "pkg kernel state not registered".into(),
    ))?;
    // The kernel's registries call `tauri::async_runtime::block_on` internally
    // (DB writes, content-server registration). Calling that from a Tokio
    // worker panics with "Cannot start a runtime from within a runtime", so
    // run the install on a blocking thread.
    let kernel_arc = kernel.0.clone();
    let path = std::path::PathBuf::from(&body.install_path);
    // iyke-driven installs are local sideloads — same provenance class as
    // the FE workspace install path.
    let source = crate::pkg::InstallSource::Local {
        path: body.install_path.clone(),
    };
    // Resolve scope. The bridge has the PaDb in Extension; reuse the same
    // helper as the FE Tauri command so the wire format stays single-sourced.
    let pa_db = app
        .try_state::<std::sync::Arc<crate::commands::db::PaDb>>()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "pa_db state not registered".into(),
        ))?
        .inner()
        .clone();
    let project_id = crate::commands::pkg::resolve_install_scope_for_iyke(pa_db, body.scope)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let installed = tokio::task::spawn_blocking(move || {
        kernel_arc.install_from_path(&path, source, project_id)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("join error: {e}"),
        )
    })?
    .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    serde_json::to_value(&installed)
        .map(|v| Json(serde_json::json!({ "installed": v })))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("serialize installed summary: {e}"),
            )
        })
}

pub async fn post_devtools(
    Extension(app): Extension<AppHandle>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    let window = app.get_webview_window("main").ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "main window not found".into(),
    ))?;
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(ok())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "devtools only available in debug builds".into(),
        ))
    }
}

// --- helpers --------------------------------------------------------------

fn emit(app: &AppHandle, event: &str, payload: Value) -> Result<(), (StatusCode, String)> {
    app.emit(event, payload).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to emit {event}: {e}"),
        )
    })
}

/// Modes recognized by the in-app `useShellStore`. Kept in sync with
/// `src/lib/shell/shell-store.ts` (`ActivityMode`). Server-side check is
/// a sanity gate; the FE listener is the source of truth.
fn is_valid_mode(m: &str) -> bool {
    matches!(
        m,
        "app"
            | "files"
            | "agents"
            | "sessions"
            | "settings"
            | "studio"
            | "storyboard"
            | "video-engine"
            | "hyperframes"
            | "canvas-design"
            | "image-generator"
    )
}
