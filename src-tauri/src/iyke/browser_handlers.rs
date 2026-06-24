//! HTTP handlers for `/iyke/browser/*` — the shell-side bridge that the
//! pkg-browser MCP server (and any other localhost client with a bearer
//! token) calls into.
//!
//! Pane addressing across this boundary is **kernel-shaped**:
//! `(pkg_id, pane_id)`, where `pkg_id` is the calling pkg (e.g.
//! `com.ikenga.mcp-browser`) and `pane_id` is whatever string the caller
//! chose (`b1`, `b2`, etc. for the pkg-browser MCP — but the shell
//! treats it as an opaque key). The kernel's webview capability check
//! happens inside `WebviewPanesRegistry::create`, so callers don't get
//! to spin up child webviews for pkgs that haven't declared
//! `capabilities.webview.child_webviews = true`.
//!
//! Three flavors of handler:
//! - **kernel-direct**: open / close / list / goto — just call the
//!   matching `WebviewPanesRegistry` method.
//! - **eval-only (fire-and-forget)**: back / forward / reload — eval a
//!   one-line JS command into the child webview.
//! - **eval + reply RPC**: snapshot / read_text / click / fill / select /
//!   press_key / wait_for / eval — eval into the child webview a closure
//!   that runs `window.__ikengaPkgBrowser.<helper>(...)` and POSTs the
//!   result back to `/iyke/browser/_reply` via `BrowserRpc::request`.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Json as JsonBody, Query},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::pkg::webview::{PaneRect, WebviewPanesRegistry};

use super::browser_rpc::{BrowserRpc, ReplyAck, ReplyEnvelope};
use super::chrome_engine::{ChromeEngineRegistry, PaneEngine};
use crate::pkg::chrome::actions as chrome_actions;
use crate::pkg::chrome::snapshot as chrome_snapshot;

/// Hop to the GTK / NSApplication main thread to invoke a `WebviewPanesRegistry`
/// method that touches Tauri builder APIs. The kernel uses synchronous
/// `WebviewWindowBuilder::build()` / `Webview::eval()` internally; those post
/// to the main loop and block until it pumps. Calling them from an axum-tokio
/// worker without an explicit hop hangs on Linux WebKitGTK because the main
/// loop never gets a tick while our task is blocked.
async fn on_main<R, F>(app: &tauri::AppHandle, f: F) -> Result<R, (StatusCode, String)>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| err500(format!("run_on_main_thread: {e}")))?;
    rx.await
        .map_err(|e| err500(format!("main-thread channel closed: {e}")))
}

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const INTERACTION_TIMEOUT: Duration = Duration::from_secs(5);
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(15);
const WAIT_FOR_DEFAULT_MS: u64 = 10_000;
const WAIT_FOR_MAX_MS: u64 = 60_000;
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Carries the live Iyke port to handlers that need to bake it into eval
/// closures (so the in-page reply fetch knows where to POST).
#[derive(Clone, Copy)]
pub struct BrowserPort(pub u16);

// ── Common body shapes ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PaneKey {
    pub pkg_id: String,
    pub pane_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PaneKeyQuery {
    #[serde(default)]
    pub pkg_id: Option<String>,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

fn ok() -> Json<OkResponse> {
    Json(OkResponse { ok: true })
}

fn err500<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
}

fn err400<S: Into<String>>(msg: S) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, msg.into())
}

// ── open / close / list ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct OpenBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub url: String,
    #[serde(default)]
    pub partition: Option<String>,
    /// Engine backing this pane. `None`/absent → webkit (contract default).
    /// `"chrome"` routes to Managed Chrome over CDP.
    #[serde(default)]
    pub engine: Option<String>,
    /// Initial pane rect. Required for webkit (in-shell child webview); ignored
    /// for chrome (Managed Chrome owns its own OS window — G-05), hence optional.
    #[serde(default)]
    pub rect: Option<PaneRect>,
}

#[derive(Serialize)]
pub struct OpenResult {
    pub pkg_id: String,
    pub pane_id: String,
    pub webview_label: String,
    pub partition: String,
    /// The resolved engine backing this pane, echoed back.
    pub engine: &'static str,
}

pub async fn post_browser_open(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<OpenBody>,
) -> Result<Json<OpenResult>, (StatusCode, String)> {
    // Engine is decided here at open and remembered (chrome panes live in the
    // chrome registry; absence there means webkit). Subsequent verbs dispatch
    // off that recorded engine.
    if PaneEngine::parse(body.engine.as_deref()) == PaneEngine::Chrome {
        // Managed Chrome owns its own OS window — `rect` is ignored (G-05).
        // The managed-profile name doubles as the partition.
        let partition = body.partition.clone().unwrap_or_else(|| "default".to_string());
        chrome
            .open(&body.pkg_id, &body.pane_id, &partition, &body.url)
            .await
            .map_err(err500)?;
        return Ok(Json(OpenResult {
            pkg_id: body.pkg_id,
            pane_id: body.pane_id,
            // No shell webview label for a Managed-Chrome OS window.
            webview_label: String::new(),
            partition,
            engine: "chrome",
        }));
    }

    // WebKit (default) — unchanged kernel-direct path; rect is required.
    let rect = body
        .rect
        .ok_or_else(|| err400("rect required for webkit panes"))?;
    let app_for_main = app.clone();
    let panes_for_main = panes.clone();
    let pkg_id = body.pkg_id.clone();
    let pane_id = body.pane_id.clone();
    let url = body.url.clone();
    let partition_opt = body.partition.clone();
    let webview_label = on_main(&app, move || {
        panes_for_main.create(
            &app_for_main,
            &pkg_id,
            &pane_id,
            &url,
            rect,
            partition_opt.as_deref(),
        )
    })
    .await?
    .map_err(err500)?;
    Ok(Json(OpenResult {
        pkg_id: body.pkg_id,
        pane_id: body.pane_id,
        webview_label,
        partition: body.partition.unwrap_or_else(|| "default".to_string()),
        engine: "webkit",
    }))
}

pub async fn post_browser_close(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        // Drop the ChromePane — its `ManagedChrome` Drop severs the CDP pump;
        // process teardown is the lifecycle layer's concern (conservative).
        chrome.remove(&body.pkg_id, &body.pane_id).await;
        return Ok(ok());
    }
    let panes_for_main = panes.clone();
    on_main(&app, move || {
        panes_for_main.destroy(&body.pkg_id, &body.pane_id)
    })
    .await?
    .map_err(err500)?;
    Ok(ok())
}

#[derive(Serialize)]
pub struct ListEntry {
    pub pkg_id: String,
    pub pane_id: String,
    pub webview_label: String,
    pub current_url: Option<String>,
    pub partition: String,
    pub surface_kind: &'static str,
    pub paused: bool,
    /// Engine backing this pane (`"webkit"` or `"chrome"`).
    pub engine: &'static str,
    /// Process-lifecycle state — `None` for webkit panes (the in-shell webview
    /// has no separate OS process), the `ChromeState` label for chrome panes.
    pub process_state: Option<&'static str>,
    /// Last rect handed to the kernel — useful for verifying that the FE's
    /// ResizeObserver in `PkgWebviewHost` is tracking the host pane. `None` for
    /// chrome panes (Managed Chrome owns its own OS window — no shell-pane rect).
    pub stored_rect: Option<crate::pkg::webview::PaneRect>,
}

#[derive(Serialize)]
pub struct ListResult {
    pub panes: Vec<ListEntry>,
}

pub async fn get_browser_list(
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Query(q): Query<PaneKeyQuery>,
) -> Json<ListResult> {
    let mut entries: Vec<ListEntry> = panes
        .statuses()
        .into_iter()
        .filter(|s| q.pkg_id.as_ref().is_none_or(|p| p == &s.pkg_id))
        .map(|s| ListEntry {
            pkg_id: s.pkg_id,
            pane_id: s.pane_id,
            webview_label: s.webview_label,
            current_url: s.current_url,
            partition: s.partition,
            surface_kind: s.surface_kind,
            paused: s.paused,
            engine: "webkit",
            process_state: None,
            stored_rect: Some(s.stored_rect),
        })
        .collect();

    // Chrome panes live in the parallel registry; geometry is null for them.
    for s in chrome.statuses(q.pkg_id.as_deref()).await {
        entries.push(ListEntry {
            pkg_id: s.pkg_id,
            pane_id: s.pane_id,
            webview_label: String::new(),
            current_url: s.current_url,
            partition: s.partition,
            surface_kind: "chrome",
            paused: s.paused,
            engine: s.engine,
            process_state: Some(s.state),
            stored_rect: None,
        });
    }

    Json(ListResult { panes: entries })
}

// ── navigation ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GotoBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub url: String,
}

pub async fn post_browser_goto(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<GotoBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        // Returns immediately (pre-navigation URL on slow loads is fine —
        // callers pair with wait_for if they need settle).
        chrome_actions::goto(&page, &body.url).await.map_err(err500)?;
        return Ok(ok());
    }
    let panes_for_main = panes.clone();
    on_main(&app, move || {
        panes_for_main.navigate(&body.pkg_id, &body.pane_id, &body.url)
    })
    .await?
    .map_err(err500)?;
    Ok(ok())
}

pub async fn post_browser_back(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        chrome_actions::back(&page).await.map_err(err500)?;
        return Ok(ok());
    }
    let panes_for_main = panes.clone();
    on_main(&app, move || {
        panes_for_main.eval(&body.pkg_id, &body.pane_id, "window.history.back()")
    })
    .await?
    .map_err(err500)?;
    Ok(ok())
}

pub async fn post_browser_forward(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        chrome_actions::forward(&page).await.map_err(err500)?;
        return Ok(ok());
    }
    let panes_for_main = panes.clone();
    on_main(&app, move || {
        panes_for_main.eval(&body.pkg_id, &body.pane_id, "window.history.forward()")
    })
    .await?
    .map_err(err500)?;
    Ok(ok())
}

pub async fn post_browser_reload(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        chrome_actions::reload(&page).await.map_err(err500)?;
        return Ok(ok());
    }
    let panes_for_main = panes.clone();
    on_main(&app, move || {
        panes_for_main.eval(&body.pkg_id, &body.pane_id, "window.location.reload()")
    })
    .await?
    .map_err(err500)?;
    Ok(ok())
}

// ── snapshot ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SnapshotBody {
    pub pkg_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub all: bool,
}

pub async fn post_browser_snapshot(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<SnapshotBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        let (snap, refs) = chrome_snapshot::take_snapshot(&page).await.map_err(err500)?;
        // Persist the fresh ref store + bump the per-pane snapshot counter so
        // later click/fill resolve `e<N>` against this snapshot.
        let snapshot_id = chrome
            .update_snapshot(&body.pkg_id, &body.pane_id, refs)
            .await
            .map_err(err500)?;
        // Same wire shape the WebKit path emits: { url, title, text, nodes,
        // snapshotId, id }.
        let mut obj = match serde_json::to_value(&snap).map_err(err500)? {
            Value::Object(m) => m,
            other => return Err(err500(format!("snapshot serialized to non-object: {other}"))),
        };
        obj.insert("snapshotId".into(), Value::from(snapshot_id));
        obj.insert("id".into(), Value::String(body.pane_id.clone()));
        return Ok(Json(Value::Object(obj)));
    }

    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    let body_js = format!(
        "__ipb.snapshot({{ query: {q}, all: {all} }})",
        q = json::to_string(&body.query),
        all = body.all,
    );
    let payload = rpc
        .request(
            &app,
            &panes,
            port.0,
            &body.pkg_id,
            &body.pane_id,
            SNAPSHOT_TIMEOUT,
            &body_js,
        )
        .await
        .map_err(err500)?;
    let mut obj = match payload {
        Value::Object(m) => m,
        other => {
            return Err(err500(format!(
                "snapshot returned non-object payload: {other}"
            )))
        }
    };
    obj.insert("id".into(), Value::String(body.pane_id.clone()));
    Ok(Json(Value::Object(obj)))
}

// ── read_text ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ReadTextBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub r#ref: String,
}

pub async fn post_browser_read_text(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<ReadTextBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        // WP-06's chrome action surface exposes no backend-node → text verb
        // (the snapshot already carries each node's name/value, which is the
        // intended read path for chrome panes). Surface a clear 501 rather than
        // a silent wrong answer; a dedicated `read_text` CDP verb is a WP-08+
        // nicety.
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            "read_text is not implemented for engine=chrome — read the node's \
             name/value from /iyke/browser/snapshot instead"
                .into(),
        ));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    if !is_ref(&body.r#ref) {
        return Err(err400(format!("invalid ref: {:?}", body.r#ref)));
    }
    let body_js = format!("__ipb.readText({})", json::to_string(&body.r#ref));
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        INTERACTION_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

// ── screenshot (not yet implemented for child webviews) ──────────────────────

#[derive(Debug, Deserialize)]
pub struct ScreenshotBody {
    pub pkg_id: String,
    pub pane_id: String,
    /// Override the default output path. Default:
    /// `<app_local_data>/screenshots/browser-<pkg>-<pane>-<ts>.png`.
    #[serde(default)]
    pub out_path: Option<String>,
}

pub async fn post_browser_screenshot(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<ScreenshotBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Chrome is the FIRST engine to satisfy /screenshot (WebKit child webviews
    // still 501 — the main-window screenshot command can't target them).
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        let shot = chrome_actions::screenshot(&page).await.map_err(err500)?;
        // CDP returns base64 PNG; decode + write to disk for the
        // `{ path, width, height, bytes }` wire shape the contract expects.
        use base64::Engine as _;
        let png = base64::engine::general_purpose::STANDARD
            .decode(shot.base64.as_bytes())
            .map_err(|e| err500(format!("decode screenshot base64: {e}")))?;
        let out = screenshot_out_path(&app, &body)?;
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| err500(format!("create screenshot dir: {e}")))?;
        }
        std::fs::write(&out, &png).map_err(|e| err500(format!("write screenshot: {e}")))?;
        return Ok(Json(serde_json::json!({
            "path": out.to_string_lossy(),
            // Best-effort dims (read back from the page surface, not the PNG
            // header) — accurate for the captured viewport in practice.
            "width": shot.width,
            "height": shot.height,
            "bytes": png.len(),
        })));
    }

    Err((
        StatusCode::NOT_IMPLEMENTED,
        "browser screenshot is only supported for engine=chrome — the WebKit child-webview \
         path is Phase 4+ (the existing screenshot command targets the main window/shell pane, \
         not pkg-owned child webviews)."
            .into(),
    ))
}

/// Resolve the screenshot output path: caller override, else a timestamped
/// default under the app-local screenshots dir (CWD-relative fallback if the
/// data dir can't be resolved without a Tauri handle here).
fn screenshot_out_path(
    app: &tauri::AppHandle,
    body: &ScreenshotBody,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    if let Some(p) = &body.out_path {
        return Ok(std::path::PathBuf::from(p));
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let slug = format!(
        "browser-{}-{}-{ts}.png",
        body.pkg_id.replace(['/', '.'], "_"),
        body.pane_id.replace(['/', '.'], "_"),
    );
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join("screenshots"))
        .unwrap_or_else(|_| std::path::PathBuf::from("screenshots"));
    Ok(dir.join(slug))
}

// Suppress unused-warning for the timeout constant until the webkit path lands.
#[allow(dead_code)]
const _SCREENSHOT_TIMEOUT_HINT: Duration = SCREENSHOT_TIMEOUT;

// ── click / fill / select / press_key ───────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ClickBody {
    pub pkg_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

pub async fn post_browser_click(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<ClickBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let r = chrome_require_ref(&body.r#ref, &body.selector, &body.text)?;
        let (page, refs) = chrome
            .page_and_refs(&body.pkg_id, &body.pane_id)
            .await
            .map_err(err500)?;
        let store = chrome_refs(refs)?;
        chrome_actions::click(&page, &store, &r).await.map_err(err500)?;
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    require_one_target(&body.r#ref, &body.selector, &body.text)?;
    if let Some(r) = &body.r#ref {
        if !is_ref(r) {
            return Err(err400(format!("invalid ref: {r:?}")));
        }
    }
    let spec = target_spec(&body.r#ref, &body.selector, &body.text);
    let body_js = format!("__ipb.click({spec})");
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        INTERACTION_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

#[derive(Debug, Deserialize)]
pub struct FillBody {
    pub pkg_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    pub text: String,
    #[serde(default)]
    pub replace: bool,
}

pub async fn post_browser_fill(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<FillBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let r = chrome_require_ref(&body.r#ref, &body.selector, &None)?;
        let (page, refs) = chrome
            .page_and_refs(&body.pkg_id, &body.pane_id)
            .await
            .map_err(err500)?;
        let store = chrome_refs(refs)?;
        chrome_actions::fill(&page, &store, &r, &body.text, body.replace)
            .await
            .map_err(err500)?;
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    require_one_target(&body.r#ref, &body.selector, &None)?;
    if let Some(r) = &body.r#ref {
        if !is_ref(r) {
            return Err(err400(format!("invalid ref: {r:?}")));
        }
    }
    let spec = target_spec(&body.r#ref, &body.selector, &None);
    let body_js = format!(
        "__ipb.fill({spec}, {text}, {replace})",
        text = json::to_string(&body.text),
        replace = body.replace,
    );
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        INTERACTION_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

#[derive(Debug, Deserialize)]
pub struct SelectBody {
    pub pkg_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    pub value: String,
}

pub async fn post_browser_select(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<SelectBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let r = chrome_require_ref(&body.r#ref, &body.selector, &None)?;
        let (page, refs) = chrome
            .page_and_refs(&body.pkg_id, &body.pane_id)
            .await
            .map_err(err500)?;
        let store = chrome_refs(refs)?;
        // `actions::select` returns Result<()> (no echoed option) — the
        // contract's BrowserSelectResult is just `{ ok: true }`.
        chrome_actions::select(&page, &store, &r, &body.value)
            .await
            .map_err(err500)?;
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    require_one_target(&body.r#ref, &body.selector, &None)?;
    if let Some(r) = &body.r#ref {
        if !is_ref(r) {
            return Err(err400(format!("invalid ref: {r:?}")));
        }
    }
    let spec = target_spec(&body.r#ref, &body.selector, &None);
    let body_js = format!(
        "__ipb.select({spec}, {value})",
        value = json::to_string(&body.value),
    );
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        INTERACTION_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

#[derive(Debug, Deserialize)]
pub struct PressKeyBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub combo: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
}

pub async fn post_browser_press_key(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<PressKeyBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        if body.combo.trim().is_empty() {
            return Err(err400("combo must not be empty"));
        }
        if body.selector.is_some() {
            return Err(err400(
                "engine=chrome targets by ref only (no selector) — snapshot first",
            ));
        }
        if let Some(r) = &body.r#ref {
            if !is_ref(r) {
                return Err(err400(format!("invalid ref: {r:?}")));
            }
        }
        let (page, refs) = chrome
            .page_and_refs(&body.pkg_id, &body.pane_id)
            .await
            .map_err(err500)?;
        // A ref is optional for press_key (combo can target the focused
        // element). Only resolve the store if a ref was given.
        let store = if body.r#ref.is_some() {
            chrome_refs(refs)?
        } else {
            chrome_snapshot::RefStore::default()
        };
        chrome_actions::press_key(&page, &store, body.r#ref.as_deref(), &body.combo)
            .await
            .map_err(err500)?;
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    if body.combo.trim().is_empty() {
        return Err(err400("combo must not be empty"));
    }
    if let Some(r) = &body.r#ref {
        if !is_ref(r) {
            return Err(err400(format!("invalid ref: {r:?}")));
        }
    }
    let spec = target_spec(&body.r#ref, &body.selector, &None);
    let body_js = format!(
        "__ipb.pressKey({spec}, {combo})",
        combo = json::to_string(&body.combo),
    );
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        INTERACTION_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

// ── wait_for ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WaitForBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub kind: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

pub async fn post_browser_wait_for(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<WaitForBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !matches!(
        body.kind.as_str(),
        "url" | "ref" | "text" | "gone-text" | "selector" | "gone-selector" | "idle"
    ) {
        return Err(err400(format!("unknown wait_for kind: {:?}", body.kind)));
    }

    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let timeout_ms = body
            .timeout_ms
            .unwrap_or(WAIT_FOR_DEFAULT_MS)
            .min(WAIT_FOR_MAX_MS);
        let value = body.value.clone().unwrap_or_default();
        // Map the wire kind → the WP-06 `WaitFor` predicate. `ref` has no
        // native CDP predicate; the routing layer folds it into a `selector`
        // wait on `[ikenga-ref]`-free DOM is not possible, so we treat a `ref`
        // wait as "the ref currently resolves in the latest snapshot store"
        // handled below by re-snapshot; for simplicity we map it to an Idle
        // wait (page settle) — the caller re-snapshots after. Other kinds map
        // directly.
        let pred = match body.kind.as_str() {
            "url" => chrome_actions::WaitFor::Url(value),
            "text" => chrome_actions::WaitFor::Text(value),
            "gone-text" => chrome_actions::WaitFor::GoneText(value),
            "selector" => chrome_actions::WaitFor::Selector(value),
            "gone-selector" => chrome_actions::WaitFor::GoneSelector(value),
            // `idle` and `ref` (best-effort) both wait for the page to settle.
            _ => chrome_actions::WaitFor::Idle,
        };
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        let outcome = chrome_actions::wait_for(&page, &pred, Some(timeout_ms))
            .await
            .map_err(err500)?;
        let mut obj = serde_json::Map::new();
        obj.insert("satisfied".into(), Value::Bool(outcome.satisfied));
        obj.insert("elapsed_ms".into(), Value::from(outcome.elapsed_ms));
        if !outcome.satisfied {
            obj.insert(
                "message".into(),
                Value::String(format!(
                    "timed out waiting for {}={}",
                    body.kind,
                    body.value.unwrap_or_default()
                )),
            );
        }
        return Ok(Json(Value::Object(obj)));
    }

    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    let timeout_ms = body
        .timeout_ms
        .unwrap_or(WAIT_FOR_DEFAULT_MS)
        .min(WAIT_FOR_MAX_MS);
    let value = body.value.unwrap_or_default();
    let body_js = format!(
        "__ipb.waitFor({kind}, {value}, {timeout_ms})",
        kind = json::to_string(&body.kind),
        value = json::to_string(&value),
        timeout_ms = timeout_ms,
    );
    // Allow the in-page wait to use the full timeout; give the eval round-trip a 2s slack.
    let rpc_timeout = Duration::from_millis(timeout_ms + 2_000);
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        rpc_timeout,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

// ── eval (escape hatch) ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct EvalBody {
    pub pkg_id: String,
    pub pane_id: String,
    pub script: String,
}

pub async fn post_browser_eval(
    Extension(app): Extension<tauri::AppHandle>,
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    Extension(rpc): Extension<BrowserRpc>,
    Extension(port): Extension<BrowserPort>,
    JsonBody(body): JsonBody<EvalBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome_check_not_paused(&chrome, &body.pkg_id, &body.pane_id).await?;
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        // `Runtime.evaluate` of the expression directly — return the JSON value.
        let v = chrome_actions::eval(&page, &body.script).await.map_err(err500)?;
        return Ok(Json(v));
    }
    check_not_paused(&panes, &body.pkg_id, &body.pane_id)?;
    // The user script must evaluate to a JSON-serializable value (or a
    // Promise resolving to one). It runs inside the same closure that
    // calls `__ipb.sendReply` — anything thrown is surfaced as an error.
    let body_js = format!("(() => {{ {} }})()", body.script);
    rpc.request(
        &app,
        &panes,
        port.0,
        &body.pkg_id,
        &body.pane_id,
        EVAL_TIMEOUT,
        &body_js,
    )
    .await
    .map_err(err500)
    .map(Json)
}

// ── pause / resume (Phase 5) ─────────────────────────────────────────────────

pub async fn post_browser_pause(
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome
            .set_paused(&body.pkg_id, &body.pane_id, true)
            .await
            .map_err(err500)?;
        return Ok(ok());
    }
    panes
        .set_paused(&body.pkg_id, &body.pane_id, true)
        .map_err(err500)?;
    Ok(ok())
}

pub async fn post_browser_resume(
    Extension(panes): Extension<Arc<WebviewPanesRegistry>>,
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        chrome
            .set_paused(&body.pkg_id, &body.pane_id, false)
            .await
            .map_err(err500)?;
        return Ok(ok());
    }
    panes
        .set_paused(&body.pkg_id, &body.pane_id, false)
        .map_err(err500)?;
    Ok(ok())
}

/// Guard helper: 409 Conflict when the pane is paused. Snapshot/interaction
/// handlers call this before the eval hop.
fn check_not_paused(
    panes: &WebviewPanesRegistry,
    pkg_id: &str,
    pane_id: &str,
) -> Result<(), (StatusCode, String)> {
    let paused = panes.is_paused(pkg_id, pane_id).map_err(err500)?;
    if paused {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "pane ({pkg_id}, {pane_id}) is paused — resume it via /iyke/browser/resume \
                 before sending snapshot/interaction calls"
            ),
        ));
    }
    Ok(())
}

// ── focus (no-op placeholder) ───────────────────────────────────────────────

pub async fn post_browser_focus(
    Extension(chrome): Extension<Arc<ChromeEngineRegistry>>,
    JsonBody(body): JsonBody<PaneKey>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    if chrome.is_chrome(&body.pkg_id, &body.pane_id).await {
        // G-05: chrome `/focus` → CDP `Page.bringToFront` (NOT shell-pane focus).
        let page = chrome.page(&body.pkg_id, &body.pane_id).await.map_err(err500)?;
        chrome_actions::bring_to_front(&page).await.map_err(err500)?;
        return Ok(ok());
    }
    // WebKit: kernel doesn't expose focus today (macOS/Windows in-window
    // children and Linux borderless top-levels both need different OS-level
    // affordances). Returning ok preserves the tool surface; no-op for v1.
    Ok(ok())
}

// ── _reply (unauthed; oneshot_token-gated) ──────────────────────────────────

pub async fn post_browser_reply(
    Extension(rpc): Extension<BrowserRpc>,
    JsonBody(env): JsonBody<ReplyEnvelope>,
) -> Result<Json<ReplyAck>, (StatusCode, String)> {
    rpc.resolve(env)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    Ok(Json(ReplyAck { ok: true }))
}

// ── _reply (Tauri command path) ─────────────────────────────────────────────
//
// The HTTP reply route above works fine for clients that can talk plain
// HTTP, but the in-page reply from a child webview hitting an external
// origin (https://example.com etc.) is killed by browser network policy
// — mixed-content (HTTPS → HTTP localhost), CORS preflight, and (most
// importantly) Private Network Access — before the body reaches us. The
// canonical Tauri 2 way to round-trip a value back from a page on a
// remote origin is to call `window.__TAURI_INTERNALS__.invoke(...)` and
// let Tauri's own IPC carry the bytes. We expose `iyke_browser_reply`
// here for that path; the capability `pkg-browser-child.json` opens it
// up to webviews with labels matching `pkg-*` on any remote URL.
//
// Security: the command does no auth of its own. Spoofing is prevented
// by the same `oneshot_token` (122-bit UUID) check that gates the HTTP
// route — `BrowserRpc::resolve` validates it in constant time. The
// command is intentionally narrow: it accepts the reply envelope and
// nothing else.

#[tauri::command]
pub async fn iyke_browser_reply(
    rpc: tauri::State<'_, BrowserRpc>,
    request_id: String,
    oneshot_token: String,
    ok: bool,
    payload: Option<Value>,
    error: Option<String>,
) -> Result<ReplyAck, String> {
    let env = ReplyEnvelope {
        request_id,
        oneshot_token,
        ok,
        payload,
        error,
    };
    rpc.resolve(env).await.map_err(|e| format!("{e:#}"))?;
    Ok(ReplyAck { ok: true })
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Chrome-pane pause guard (parity with `check_not_paused` for WebKit). 409 if
/// the pane is paused.
async fn chrome_check_not_paused(
    chrome: &ChromeEngineRegistry,
    pkg_id: &str,
    pane_id: &str,
) -> Result<(), (StatusCode, String)> {
    if chrome.is_paused(pkg_id, pane_id).await {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "chrome pane ({pkg_id}, {pane_id}) is paused — resume it via \
                 /iyke/browser/resume before sending snapshot/interaction calls"
            ),
        ));
    }
    Ok(())
}

/// Chrome interactions target by `ref` only (the WP-06 CDP action surface
/// resolves a `e<N>` ref to a backend node id; it has no selector/text path).
/// Require exactly a valid ref and reject selector/text with a clear 400.
fn chrome_require_ref(
    r#ref: &Option<String>,
    selector: &Option<String>,
    text: &Option<String>,
) -> Result<String, (StatusCode, String)> {
    if selector.is_some() || text.is_some() {
        return Err(err400(
            "engine=chrome targets by `ref` only (no selector/text) — take a \
             /iyke/browser/snapshot first and use the returned ref",
        ));
    }
    let r = r#ref
        .as_ref()
        .ok_or_else(|| err400("engine=chrome requires a `ref` (snapshot first)"))?;
    if !is_ref(r) {
        return Err(err400(format!("invalid ref: {r:?}")));
    }
    Ok(r.clone())
}

/// Unwrap the pane's latest snapshot ref store, erroring if no snapshot has been
/// taken yet (refs can't resolve without one).
fn chrome_refs(
    refs: Option<chrome_snapshot::RefStore>,
) -> Result<chrome_snapshot::RefStore, (StatusCode, String)> {
    refs.ok_or_else(|| {
        err400("no snapshot taken for this chrome pane yet — call /iyke/browser/snapshot first")
    })
}

fn require_one_target(
    r#ref: &Option<String>,
    selector: &Option<String>,
    text: &Option<String>,
) -> Result<(), (StatusCode, String)> {
    let count = r#ref.is_some() as u8 + selector.is_some() as u8 + text.is_some() as u8;
    if count != 1 {
        return Err(err400(
            "must set exactly one of: ref, selector, text".to_string(),
        ));
    }
    Ok(())
}

fn target_spec(r#ref: &Option<String>, selector: &Option<String>, text: &Option<String>) -> String {
    let mut o = serde_json::Map::new();
    if let Some(r) = r#ref {
        o.insert("ref".into(), Value::String(r.clone()));
    }
    if let Some(s) = selector {
        o.insert("selector".into(), Value::String(s.clone()));
    }
    if let Some(t) = text {
        o.insert("text".into(), Value::String(t.clone()));
    }
    serde_json::to_string(&Value::Object(o)).unwrap_or_else(|_| "{}".to_string())
}

fn is_ref(s: &str) -> bool {
    if !s.starts_with('e') || s.len() < 2 {
        return false;
    }
    s[1..].chars().all(|c| c.is_ascii_digit())
}

// Re-export `serde_json` under `json` so the format!() body sites are succinct.
mod json {
    pub fn to_string<T: serde::Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap_or_else(|_| "null".to_string())
    }
}
