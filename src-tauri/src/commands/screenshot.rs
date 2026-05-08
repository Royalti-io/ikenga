//! Screenshot capture for the PA workspace.
//!
//! Wayland/GNOME has no usable compositor screencopy without a portal prompt,
//! and Tauri 2 doesn't expose `WebviewWindow::capture()` on Linux. We dodge
//! both by capturing in the renderer process: emit an event to the FE, the FE
//! runs `modern-screenshot` against the live DOM, posts the PNG bytes back via
//! `screenshot_capture_done`, and we write to disk. Works regardless of focus
//! or minimized state because the React tree stays mounted.
//!
//! The same `capture` helper is the single entry point for in-app calls
//! (`screenshot_window` / `screenshot_pane`), iyke HTTP routes, and global
//! shortcuts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex, RwLock};
use uuid::Uuid;

// modern-screenshot inlines all stylesheets/fonts/images for the captured
// subtree, which on the full workspace DOM (mini-app iframes + hundreds of
// nodes) routinely exceeds 10s. 60s is generous enough to absorb cold renders
// without making genuine FE hangs feel infinite.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_EVENT: &str = "screenshot://request";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenshotKind {
    Window,
    Pane,
}

impl ScreenshotKind {
    fn stem(self, pane_id: Option<&str>) -> String {
        match (self, pane_id) {
            (ScreenshotKind::Window, _) => "window".to_string(),
            (ScreenshotKind::Pane, Some(id)) => format!("pane-{}", sanitize_id(id)),
            (ScreenshotKind::Pane, None) => "pane".to_string(),
        }
    }
}

/// What the FE returns after rendering. Bytes are base64 PNG to survive the
/// JSON event boundary; same shape as PTY chunks elsewhere in this crate.
#[derive(Debug, Clone)]
pub struct CaptureResult {
    pub png_bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Result handed back to callers (Tauri commands, iyke handlers, CLI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes_len: usize,
}

/// Result returned across the Rust↔FE oneshot. Either the captured PNG
/// or a structured failure (so callers can distinguish a timeout from
/// a cross-origin iframe vs. a missing pane).
#[derive(Debug, Clone)]
pub enum CaptureOutcome {
    Ok(CaptureResult),
    Err(String),
}

/// Pending captures keyed by request_id. The capture helper inserts a sender,
/// emits the request event, then awaits the receiver. The FE invokes
/// `screenshot_capture_done` (success) or `screenshot_capture_failed`
/// (cross-origin iframe, missing pane, etc.) which pop the sender and
/// resolve the oneshot.
pub type ScreenshotPending = Arc<Mutex<HashMap<String, oneshot::Sender<CaptureOutcome>>>>;

pub fn new_pending() -> ScreenshotPending {
    Arc::new(Mutex::new(HashMap::new()))
}

// ─── User-overridable output dir ──────────────────────────────────────────────
//
// Persisted as JSON in `app_data_dir/screenshot-config.json`. State held in a
// `tokio::sync::RwLock` so reads on the capture hot path don't block writers
// from settings UI. `override_dir` is stored as the user typed it (`~/...`
// allowed); we tilde-expand on read.

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScreenshotConfig {
    #[serde(default)]
    pub override_dir: Option<String>,
}

pub struct ScreenshotConfigState {
    cfg: RwLock<ScreenshotConfig>,
    path: PathBuf,
}

pub type ScreenshotConfigStateRef = Arc<ScreenshotConfigState>;

impl ScreenshotConfigState {
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join("screenshot-config.json");
        let cfg = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<ScreenshotConfig>(&s).ok())
            .unwrap_or_default();
        Self {
            cfg: RwLock::new(cfg),
            path,
        }
    }

    pub async fn override_dir(&self) -> Option<PathBuf> {
        self.cfg
            .read()
            .await
            .override_dir
            .as_ref()
            .map(|s| PathBuf::from(shellexpand::tilde(s).into_owned()))
    }

    pub async fn snapshot(&self) -> ScreenshotConfig {
        self.cfg.read().await.clone()
    }

    pub async fn set_override(&self, dir: Option<String>) -> Result<()> {
        let trimmed = dir.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
        let mut g = self.cfg.write().await;
        g.override_dir = trimmed;
        let json = serde_json::to_string_pretty(&*g)?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create parent {}", parent.display()))?;
        }
        std::fs::write(&self.path, json)
            .with_context(|| format!("write {}", self.path.display()))?;
        Ok(())
    }
}

#[derive(Serialize, Clone)]
struct RequestPayload<'a> {
    request_id: &'a str,
    kind: &'a str,
    pane_id: Option<&'a str>,
}

/// Core capture helper. Emits the request event, waits up to
/// `CAPTURE_TIMEOUT` for the FE to return PNG bytes, writes them to
/// `out_path` (or a default), returns metadata. The FE renders via
/// `modern-screenshot` against the live React tree; iframes are
/// composited in via the iyke iframe-bridge (each same-origin iframe
/// self-screenshots and posts the bytes back). This means screenshots
/// don't require window focus and can capture any pane that's mounted in
/// the DOM, even if it isn't the focused pane.
pub async fn capture(
    app: &AppHandle,
    pending: &ScreenshotPending,
    kind: ScreenshotKind,
    pane_id: Option<&str>,
    out_path: Option<String>,
) -> Result<ScreenshotResult> {
    if matches!(kind, ScreenshotKind::Pane) && pane_id.is_none() {
        return Err(anyhow!("pane_id required for pane screenshot"));
    }

    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<CaptureOutcome>();
    {
        let mut map = pending.lock().await;
        map.insert(request_id.clone(), tx);
    }

    let payload = RequestPayload {
        request_id: &request_id,
        kind: match kind {
            ScreenshotKind::Window => "window",
            ScreenshotKind::Pane => "pane",
        },
        pane_id,
    };
    if let Err(e) = app.emit(REQUEST_EVENT, &payload) {
        // Clean up registry on emit failure.
        pending.lock().await.remove(&request_id);
        return Err(anyhow!("emit screenshot request: {e}"));
    }

    let captured = match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(CaptureOutcome::Ok(r))) => r,
        Ok(Ok(CaptureOutcome::Err(msg))) => {
            return Err(anyhow!("screenshot capture failed: {msg}"));
        }
        Ok(Err(_)) => {
            return Err(anyhow!("screenshot sender dropped"));
        }
        Err(_) => {
            pending.lock().await.remove(&request_id);
            return Err(anyhow!(
                "screenshot timed out after {}s",
                CAPTURE_TIMEOUT.as_secs()
            ));
        }
    };

    let resolved_path = match out_path {
        Some(p) => PathBuf::from(shellexpand::tilde(&p).into_owned()),
        None => {
            let override_dir = match app.try_state::<ScreenshotConfigStateRef>() {
                Some(state) => state.inner().override_dir().await,
                None => None,
            };
            default_out_path_with(kind, pane_id, override_dir)?
        }
    };
    write_png(&resolved_path, &captured.png_bytes)?;

    Ok(ScreenshotResult {
        path: resolved_path.to_string_lossy().into_owned(),
        width: captured.width,
        height: captured.height,
        bytes_len: captured.png_bytes.len(),
    })
}

// ─── Native (OS-level) capture path — kept for future opt-in use ─────────────
//
// Currently unused: the default capture flow is FE-side modern-screenshot so
// it doesn't require window focus and can capture any mounted pane (even
// inactive ones). The native path is kept here so a future `--native` flag
// can use it when the user explicitly wants compositor-level capture (e.g.
// to grab a multi-window setup or anything outside the webview).

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
struct ScreenRect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[allow(dead_code)]
async fn capture_window_native(
    app: &AppHandle,
    out_path: Option<String>,
) -> Result<ScreenshotResult> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow!("main webview window not found"))?;

    // Some platforms' screenshot tools (notably `gnome-screenshot --window`
    // on mutter) capture the *focused* window. When iyke is invoked from
    // a terminal, the terminal has focus — so we must focus the Ikenga
    // window first. The brief focus-steal is the trade-off; the user can
    // alt-tab back. On X11 + Wayland-with-grim this is a no-op (we use
    // explicit window coordinates), but the focus call is harmless there
    // so we always do it.
    let _ = window.set_focus();
    // Give the compositor a tick to actually move focus before the
    // capture tool reads "focused window". 80ms is enough on mutter
    // without being noticeable.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    let pos = window.outer_position().context("outer_position")?;
    let size = window.outer_size().context("outer_size")?;
    let rect = ScreenRect {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
    };

    let png_bytes = tokio::task::spawn_blocking(move || capture_region_native(rect))
        .await
        .context("native capture join")?
        .context("native capture")?;

    let resolved_path = match out_path {
        Some(p) => PathBuf::from(shellexpand::tilde(&p).into_owned()),
        None => {
            let override_dir = match app.try_state::<ScreenshotConfigStateRef>() {
                Some(state) => state.inner().override_dir().await,
                None => None,
            };
            default_out_path_with(ScreenshotKind::Window, None, override_dir)?
        }
    };
    write_png(&resolved_path, &png_bytes)?;

    let dims = png_dimensions(&png_bytes).unwrap_or((rect.w, rect.h));
    Ok(ScreenshotResult {
        path: resolved_path.to_string_lossy().into_owned(),
        width: dims.0,
        height: dims.1,
        bytes_len: png_bytes.len(),
    })
}

fn capture_region_native(rect: ScreenRect) -> Result<Vec<u8>> {
    let tmp = std::env::temp_dir().join(format!("ikenga-screenshot-{}.png", Uuid::new_v4()));
    let result = capture_region_to(&tmp, rect);
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    result?;
    bytes.ok_or_else(|| anyhow!("screenshot tool reported success but produced no file"))
}

#[cfg(target_os = "linux")]
fn capture_region_to(out: &Path, rect: ScreenRect) -> Result<()> {
    // Wayland tooling depends on the compositor:
    //   * wlroots (sway/Hyprland): grim works directly with screencopy.
    //   * mutter (GNOME): no wlr-screencopy → grim fails. Use
    //     `gnome-screenshot --window` (portal-backed, captures focused).
    //   * KDE: use `spectacle --activewindow --background` similarly.
    // X11 falls back to scrot with the rect from Tauri.
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if is_wayland {
        let geom = format!("{},{} {}x{}", rect.x, rect.y, rect.w, rect.h);
        let grim = run_tool("grim", &["-g", &geom, &out.to_string_lossy()]);
        if grim.is_ok() {
            return Ok(());
        }
        let grim_err = grim.err().expect("checked above");

        // gnome-screenshot is the canonical mutter path. `-w` grabs the
        // focused window; the Tauri window is the active one when iyke
        // dispatches a shortcut/CLI capture, so this DTRT.
        if which_present("gnome-screenshot") {
            return run_tool(
                "gnome-screenshot",
                &["-w", "-f", &out.to_string_lossy()],
            );
        }
        if which_present("spectacle") {
            return run_tool(
                "spectacle",
                &["--activewindow", "--background", "-o", &out.to_string_lossy()],
            );
        }
        Err(anyhow!(
            "no working Wayland screenshot tool. grim said: {grim_err}. \
             Install grim (wlroots), gnome-screenshot, or spectacle."
        ))
    } else {
        // scrot --autoselect (-a) takes "x,y,w,h"; --overwrite (-o) for
        // determinism, --silent (-z) to avoid stderr chatter.
        let area = format!("{},{},{},{}", rect.x, rect.y, rect.w, rect.h);
        run_tool("scrot", &["-z", "-o", "-a", &area, &out.to_string_lossy()])
    }
}

#[cfg(target_os = "linux")]
fn which_present(tool: &str) -> bool {
    std::process::Command::new("which")
        .arg(tool)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn capture_region_to(out: &Path, rect: ScreenRect) -> Result<()> {
    // -x: silent (no shutter sound). -R: capture rect "x,y,w,h".
    let region = format!("{},{},{},{}", rect.x, rect.y, rect.w, rect.h);
    run_tool(
        "screencapture",
        &["-x", "-R", &region, &out.to_string_lossy()],
    )
}

#[cfg(target_os = "windows")]
fn capture_region_to(_out: &Path, _rect: ScreenRect) -> Result<()> {
    // TODO(windows): use PowerShell + System.Drawing or the Windows.Graphics
    // .Capture API. For now, error out with a clear message so the user can
    // fall back to modern-screenshot via the FE flag (also a TODO).
    Err(anyhow!(
        "native window capture not implemented on Windows yet"
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn capture_region_to(_out: &Path, _rect: ScreenRect) -> Result<()> {
    Err(anyhow!("native window capture not supported on this OS"))
}

fn run_tool(tool: &str, args: &[&str]) -> Result<()> {
    let out = std::process::Command::new(tool)
        .args(args)
        .output()
        .with_context(|| format!("spawn {tool}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(
            "{tool} exited with status {}: {}",
            out.status,
            stderr.trim()
        ));
    }
    Ok(())
}

/// Read `width` and `height` from a PNG's IHDR chunk. Cheap — first 24 bytes.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

fn write_png(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent {}", parent.display()))?;
    }
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// `~/.local/share/ikenga/screenshots/{stem}-{ISO8601}.png` on Linux,
/// platform equivalents elsewhere. Strips `:` from the timestamp so the
/// filename is portable to FAT/Windows shells.
pub fn default_out_path(kind: ScreenshotKind, pane_id: Option<&str>) -> Result<PathBuf> {
    default_out_path_with(kind, pane_id, None)
}

/// Same as [`default_out_path`] but lets the caller substitute a user-chosen
/// directory (from `ScreenshotConfigState`). When `override_dir` is `None` we
/// fall back to the per-platform default.
pub fn default_out_path_with(
    kind: ScreenshotKind,
    pane_id: Option<&str>,
    override_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    let dir = match override_dir {
        Some(d) => d,
        None => default_screenshot_dir()?,
    };
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let stem = kind.stem(pane_id);
    Ok(dir.join(format!("{stem}-{stamp}.png")))
}

/// Per-platform default screenshot dir, exposed so the settings UI can show
/// "(default: ...)" alongside the user override.
pub fn platform_default_screenshot_dir() -> Result<PathBuf> {
    default_screenshot_dir()
}

fn default_screenshot_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME not set"))?;
    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Application Support/ikenga/screenshots");
    #[cfg(all(unix, not(target_os = "macos")))]
    let dir = home.join(".local/share/ikenga/screenshots");
    #[cfg(target_os = "windows")]
    let dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.clone())
        .join("Ikenga/screenshots");
    Ok(dir)
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn screenshot_window(
    app: AppHandle,
    pending: State<'_, ScreenshotPending>,
    out_path: Option<String>,
) -> Result<ScreenshotResult, String> {
    capture(&app, pending.inner(), ScreenshotKind::Window, None, out_path)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn screenshot_pane(
    app: AppHandle,
    pending: State<'_, ScreenshotPending>,
    pane_id: String,
    out_path: Option<String>,
) -> Result<ScreenshotResult, String> {
    capture(
        &app,
        pending.inner(),
        ScreenshotKind::Pane,
        Some(&pane_id),
        out_path,
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

#[derive(Deserialize)]
pub struct CaptureDoneArgs {
    pub request_id: String,
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// FE callback. Decodes base64 PNG, resolves the matching pending oneshot.
#[tauri::command]
pub async fn screenshot_capture_done(
    pending: State<'_, ScreenshotPending>,
    args: CaptureDoneArgs,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args.png_base64.as_bytes())
        .map_err(|e| format!("decode base64: {e}"))?;

    let mut map = pending.inner().lock().await;
    let Some(tx) = map.remove(&args.request_id) else {
        return Err(format!("no pending capture for {}", args.request_id));
    };
    let _ = tx.send(CaptureOutcome::Ok(CaptureResult {
        png_bytes: bytes,
        width: args.width,
        height: args.height,
    }));
    Ok(())
}

#[derive(Deserialize)]
pub struct CaptureFailedArgs {
    pub request_id: String,
    pub message: String,
}

/// FE callback for capture failures (cross-origin iframe, missing pane,
/// modern-screenshot timeout). Resolves the pending oneshot with an error
/// so the caller surfaces a clean message instead of waiting out
/// `CAPTURE_TIMEOUT`.
#[tauri::command]
pub async fn screenshot_capture_failed(
    pending: State<'_, ScreenshotPending>,
    args: CaptureFailedArgs,
) -> Result<(), String> {
    let mut map = pending.inner().lock().await;
    let Some(tx) = map.remove(&args.request_id) else {
        return Err(format!("no pending capture for {}", args.request_id));
    };
    let _ = tx.send(CaptureOutcome::Err(args.message));
    Ok(())
}

// ─── Config commands ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotConfigDto {
    /// User-supplied override (raw, may contain `~`). `None` = use platform default.
    pub override_dir: Option<String>,
    /// Per-platform default, absolute path. Always populated.
    pub default_dir: String,
    /// What `capture()` will actually use right now. Tilde-expanded.
    pub effective_dir: String,
}

#[tauri::command]
pub async fn screenshot_get_config(
    state: State<'_, ScreenshotConfigStateRef>,
) -> Result<ScreenshotConfigDto, String> {
    let snap = state.inner().snapshot().await;
    let default_dir = platform_default_screenshot_dir()
        .map_err(|e| format!("{e:#}"))?
        .to_string_lossy()
        .into_owned();
    let effective_dir = match &snap.override_dir {
        Some(s) => PathBuf::from(shellexpand::tilde(s).into_owned())
            .to_string_lossy()
            .into_owned(),
        None => default_dir.clone(),
    };
    Ok(ScreenshotConfigDto {
        override_dir: snap.override_dir,
        default_dir,
        effective_dir,
    })
}

#[tauri::command]
pub async fn screenshot_set_dir(
    state: State<'_, ScreenshotConfigStateRef>,
    dir: Option<String>,
) -> Result<(), String> {
    state
        .inner()
        .set_override(dir)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    #[test]
    fn default_path_window_shape() {
        let p = default_out_path(ScreenshotKind::Window, None).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let re = Regex::new(r"^window-\d{8}T\d{6}\.png$").unwrap();
        assert!(re.is_match(&name), "got {name}");
    }

    #[test]
    fn default_path_pane_shape() {
        let p = default_out_path(ScreenshotKind::Pane, Some("leaf-42")).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let re = Regex::new(r"^pane-leaf-42-\d{8}T\d{6}\.png$").unwrap();
        assert!(re.is_match(&name), "got {name}");
    }

    #[test]
    fn pane_id_sanitization_strips_path_chars() {
        let p = default_out_path(ScreenshotKind::Pane, Some("a/b:c\\d")).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("pane-a_b_c_d-"), "got {name}");
        assert!(!name.contains('/'));
        assert!(!name.contains(':'));
        assert!(!name.contains('\\'));
    }

    #[test]
    fn write_png_creates_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("nested/deep/file.png");
        let bytes = b"\x89PNG\r\n\x1a\nfake";
        write_png(&nested, bytes).unwrap();
        let read = std::fs::read(&nested).unwrap();
        assert_eq!(read, bytes);
    }
}
