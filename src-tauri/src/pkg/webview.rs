//! Per-pkg child webview kernel.
//!
//! Owns the `(pkg_id, pane_id) → WebviewWindow` mapping and the per-jar
//! cookie partition resolution. Tauri commands in `commands/pkg_webview.rs`
//! are thin wrappers around the methods here.
//!
//! ## Architecture: borderless top-level child windows
//!
//! Initial Phase 1 used `Window::add_child(WebviewBuilder, pos, size)` to
//! float a child webview inside the main window. That path turned out to be
//! broken on Linux WebKitGTK (Tauri issue #13071 — GTK box layout ignores
//! the explicit position+size args and lays the child out as a regular
//! sibling widget). We fell back to the documented alternative: spawn a
//! borderless top-level `WebviewWindow` per pane, parented to the main
//! window (so it follows minimize/restore/close natively), and manually
//! track parent move/resize events to keep the child aligned with the
//! placeholder rect the React side measured. Same logical model, slightly
//! different OS-level mechanics — works uniformly on all three platforms.
//!
//! ## Lifecycle
//!
//! - **register** (kernel `Registry`): no-op. Webviews are created on
//!   demand when the frontend mounts a `kind = "webview"` route, not at
//!   pkg install time. The registry exists to enforce cleanup on
//!   uninstall — see `unregister`.
//! - **create** (FE-triggered): allocate a stable label, resolve the
//!   partition's data store (per-OS, see below), build a borderless
//!   `WebviewWindow` parented to the main window, install the parent-
//!   event listener (idempotent — installed once across all panes), and
//!   record the requested rect for later re-positioning on parent move.
//! - **destroy**: close the child window and drop the handle. Cookie
//!   partition data persists on disk; a future create with the same
//!   partition name picks up the same jar.
//! - **navigate / eval / set_rect**: pass-through to `WebviewWindow`
//!   methods; `set_rect` recomputes the screen-coords position from the
//!   parent window's current outer_position + the new pane rect.
//!
//! ## Cookie partition resolution
//!
//! Per-pkg, per-partition isolation. The partition path / id is derived
//! deterministically from `(pkg_id, partition_name)` so a re-create after
//! restart picks up the same cookies, localStorage, etc.
//!
//! - **Linux (WebKitGTK) + Windows (WebView2)**: `data_directory(PathBuf)`
//!   on `WebviewWindowBuilder`. Path: `app_data_dir/webjars/<pkg-slug>/<partition>/`.
//! - **macOS 14+ (WKWebView)**: `data_store_identifier([u8; 16])` derived
//!   from `sha256(pkg_id || '/' || partition_name)[..16]`.
//!
//! ## Capability check
//!
//! Create is rejected if the pkg's manifest doesn't declare
//! `capabilities.webview.child_webviews = true`. Partition names are
//! validated against `capabilities.webview.partitions` — an unknown
//! partition errors out at create time rather than silently spinning up
//! a fresh empty jar.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock, Weak};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

/// Rect passed across the Tauri command boundary in main-window-client
/// coordinates (the placeholder div's `getBoundingClientRect()` rounded to
/// integers). Translated to screen coordinates inside `create` / `set_rect`
/// by adding the parent window's `outer_position`.
#[derive(Debug, Clone, Copy, serde::Deserialize, Serialize)]
pub struct PaneRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Snapshot row surfaced via `Registry::snapshot` into `pkg_kernel_status`.
/// `live_*` fields are queried from Tauri at snapshot time so they reflect
/// what the kernel-side webview actually thinks its rect is.
#[derive(Debug, Clone, Serialize)]
pub struct WebviewPaneStatus {
    pub pkg_id: String,
    pub pane_id: String,
    pub webview_label: String,
    pub current_url: Option<String>,
    pub partition: String,
    /// Last-requested rect (in main-window-client coords) from FE.
    pub stored_rect: PaneRect,
    /// Live screen position reported by the child window.
    pub live_position: Option<[i32; 2]>,
    /// Live outer size reported by the child window.
    pub live_size: Option<[u32; 2]>,
}

struct PaneHandle {
    window: WebviewWindow,
    label: String,
    partition: String,
    current_url: RwLock<Option<String>>,
    /// The rect the FE measured. Held so the parent-event listener can
    /// re-position the child as the parent window moves/resizes.
    stored_rect: RwLock<PaneRect>,
}

#[derive(Default)]
pub struct WebviewPanesRegistry {
    /// `(pkg_id, pane_id) → handle`. Read locks for navigate/eval/set_rect;
    /// write lock only for create / destroy / unregister.
    panes: RwLock<HashMap<(String, String), Arc<PaneHandle>>>,
    /// Per-pkg cached capability — populated on `register`, read on `create`
    /// so we don't have to walk `pkg_installed` for every create.
    pkg_capabilities: RwLock<HashMap<String, PkgCapability>>,
    /// Set once, the first time `create` is called. Guards installing
    /// `on_window_event` on the parent main window — a single listener
    /// iterates all panes on each event, rather than one listener per pane.
    parent_listener_installed: OnceLock<()>,
}

#[derive(Debug, Clone, Default)]
struct PkgCapability {
    child_webviews: bool,
    partitions: Vec<String>,
}

impl WebviewPanesRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a child webview for `(pkg_id, pane_id)`. Idempotent for the
    /// same key: if a webview already exists under that pair, it's destroyed
    /// first so the new one gets the requested URL / partition / rect.
    pub fn create(
        self: &Arc<Self>,
        app: &AppHandle,
        pkg_id: &str,
        pane_id: &str,
        url: &str,
        rect: PaneRect,
        partition: Option<&str>,
    ) -> Result<String> {
        let cap = self
            .pkg_capabilities
            .read()
            .map_err(|_| anyhow!("pkg_capabilities lock poisoned"))?
            .get(pkg_id)
            .cloned()
            .unwrap_or_default();

        if !cap.child_webviews {
            return Err(anyhow!(
                "pkg `{pkg_id}` did not declare `capabilities.webview.child_webviews = true`"
            ));
        }
        let partition = partition.unwrap_or("default");
        if partition != "default" && !cap.partitions.iter().any(|p| p == partition) {
            return Err(anyhow!(
                "pkg `{pkg_id}` did not declare partition `{partition}` (declared: {:?})",
                cap.partitions
            ));
        }

        // Tear down any existing pane for the same key. Idempotency hook
        // for FE strict-mode double-mount.
        self.destroy(pkg_id, pane_id).ok();

        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("no main webview window — kernel called before setup completed?"))?;

        let label = webview_label(pkg_id, pane_id);
        let parsed_url = url::Url::parse(url).with_context(|| format!("parse url `{url}`"))?;

        let data_dir = partition_dir(app, pkg_id, partition)?;
        std::fs::create_dir_all(&data_dir).with_context(|| {
            format!("create webview data dir {}", data_dir.display())
        })?;

        // Translate pane rect (main-window-client coords) → screen coords.
        // outer_position is the screen position of the main window's top-
        // left including its title bar. The placeholder div's
        // getBoundingClientRect() returns coords relative to the main
        // window's main webview, which on all three platforms is positioned
        // at (0, 0) within the client area (no offset for our use today).
        let main_pos = main_window
            .inner_position()
            .context("read main window inner_position")?;
        let screen_x = main_pos.x + rect.x;
        let screen_y = main_pos.y + rect.y;

        let mut builder = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::External(parsed_url),
        )
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .position(screen_x as f64, screen_y as f64)
        .inner_size(rect.w as f64, rect.h as f64)
        .data_directory(data_dir);

        builder = builder
            .parent(&main_window)
            .context("set parent window for child webview")?;

        #[cfg(target_os = "macos")]
        {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(pkg_id.as_bytes());
            hasher.update(b"/");
            hasher.update(partition.as_bytes());
            let digest = hasher.finalize();
            let mut id = [0u8; 16];
            id.copy_from_slice(&digest[..16]);
            builder = builder.data_store_identifier(id);
        }

        let window = builder.build().with_context(|| format!("build {label}"))?;

        // Wayland workaround: the builder's `.position(x, y)` is silently
        // ignored on Wayland (xdg-shell doesn't let apps choose top-level
        // positions at creation). Some compositors honor `set_position`
        // after the surface is mapped — try once, log on failure. Also
        // works around the Linux WebKitGTK quirk we hit during in-window
        // `add_child` (Tauri #13071) — the borderless top-level path
        // sidesteps it entirely on X11/macOS/Windows. To use this on a
        // Wayland session, launch the app with `GDK_BACKEND=x11` so it
        // routes through XWayland.
        if let Err(e) = window.set_position(PhysicalPosition::new(screen_x, screen_y)) {
            log::warn!(
                "[pkg_webview] post-build set_position for `{label}` failed (continuing): {e}"
            );
        }

        // Detect manual close (user clicks the WM close button or the
        // compositor kills the window) so the kernel removes it from the
        // panes map automatically. Without this, subsequent set_rect /
        // navigate / eval calls would error against a dead WebviewWindow
        // handle, and `pkg_kernel_status` would falsely report it as live.
        Self::install_child_destroy_listener(
            self,
            pkg_id.to_string(),
            pane_id.to_string(),
            &window,
        );

        let handle = Arc::new(PaneHandle {
            window,
            label: label.clone(),
            partition: partition.to_string(),
            current_url: RwLock::new(Some(url.to_string())),
            stored_rect: RwLock::new(rect),
        });
        self.panes
            .write()
            .map_err(|_| anyhow!("panes lock poisoned"))?
            .insert((pkg_id.to_string(), pane_id.to_string()), handle);

        // Install the parent-event listener at most once across all panes.
        // Captures a clone of `self` (the Arc) so the closure can iterate
        // panes and re-position each child on parent moved/resized.
        self.install_parent_listener(&main_window);

        log::info!(
            "[pkg_webview] created `{label}` pkg={pkg_id} pane={pane_id} partition={partition} \
             url={url} screen_pos=({screen_x},{screen_y}) size=({},{})",
            rect.w,
            rect.h,
        );
        Ok(label)
    }

    pub fn destroy(&self, pkg_id: &str, pane_id: &str) -> Result<()> {
        let removed = self
            .panes
            .write()
            .map_err(|_| anyhow!("panes lock poisoned"))?
            .remove(&(pkg_id.to_string(), pane_id.to_string()));
        if let Some(handle) = removed {
            if let Err(e) = handle.window.close() {
                log::warn!(
                    "[pkg_webview] close `{}` failed (continuing): {e}",
                    handle.label
                );
            }
            log::info!("[pkg_webview] destroyed `{}`", handle.label);
        }
        Ok(())
    }

    pub fn navigate(&self, pkg_id: &str, pane_id: &str, url: &str) -> Result<()> {
        let handle = self
            .lookup(pkg_id, pane_id)
            .ok_or_else(|| anyhow!("no webview pane for ({pkg_id}, {pane_id})"))?;
        let parsed = url::Url::parse(url).with_context(|| format!("parse url `{url}`"))?;
        handle
            .window
            .navigate(parsed)
            .with_context(|| format!("navigate `{}` -> {url}", handle.label))?;
        if let Ok(mut cur) = handle.current_url.write() {
            *cur = Some(url.to_string());
        }
        Ok(())
    }

    pub fn eval(&self, pkg_id: &str, pane_id: &str, js: &str) -> Result<()> {
        let handle = self
            .lookup(pkg_id, pane_id)
            .ok_or_else(|| anyhow!("no webview pane for ({pkg_id}, {pane_id})"))?;
        handle
            .window
            .eval(js)
            .with_context(|| format!("eval into `{}`", handle.label))?;
        Ok(())
    }

    pub fn set_rect(&self, pkg_id: &str, pane_id: &str, rect: PaneRect) -> Result<()> {
        let handle = self
            .lookup(pkg_id, pane_id)
            .ok_or_else(|| anyhow!("no webview pane for ({pkg_id}, {pane_id})"))?;

        // Update stored rect first so the parent-event listener uses the
        // new rect on the next parent-move/resize. Then compute the new
        // screen position from the current parent outer_position.
        if let Ok(mut r) = handle.stored_rect.write() {
            *r = rect;
        }

        let app = handle.window.app_handle();
        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("no main webview window"))?;
        let main_pos = main_window
            .inner_position()
            .context("read main window inner_position")?;

        handle
            .window
            .set_position(PhysicalPosition::new(main_pos.x + rect.x, main_pos.y + rect.y))
            .with_context(|| format!("set_position `{}`", handle.label))?;
        handle
            .window
            .set_size(LogicalSize::new(rect.w as f64, rect.h as f64))
            .with_context(|| format!("set_size `{}`", handle.label))?;
        Ok(())
    }

    fn lookup(&self, pkg_id: &str, pane_id: &str) -> Option<Arc<PaneHandle>> {
        self.panes
            .read()
            .ok()?
            .get(&(pkg_id.to_string(), pane_id.to_string()))
            .cloned()
    }

    /// Per-pane: hook the child window's events so external close (user
    /// clicks WM close button, compositor kills the surface, etc.) is
    /// reflected in the panes map. Uses `Weak<Self>` to avoid the
    /// Self → panes → PaneHandle → window → closure → Self cycle.
    fn install_child_destroy_listener(
        self: &Arc<Self>,
        pkg_id: String,
        pane_id: String,
        window: &WebviewWindow,
    ) {
        let weak_self: Weak<Self> = Arc::downgrade(self);
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(reg) = weak_self.upgrade() {
                    if let Ok(mut g) = reg.panes.write() {
                        if g.remove(&(pkg_id.clone(), pane_id.clone())).is_some() {
                            log::info!(
                                "[pkg_webview] child window externally destroyed; cleaned up ({pkg_id}, {pane_id})"
                            );
                        }
                    }
                }
            }
        });
    }

    /// Idempotent: registers a single `on_window_event` listener on the main
    /// window. The listener iterates all currently-tracked panes on
    /// Moved/Resized and re-positions each child window so it stays
    /// overlaid on its assigned pane rect.
    fn install_parent_listener(self: &Arc<Self>, main_window: &WebviewWindow) {
        if self.parent_listener_installed.get().is_some() {
            return;
        }
        if self.parent_listener_installed.set(()).is_err() {
            // Lost a race with another concurrent first-create; harmless.
            return;
        }
        let registry = self.clone();
        let main = main_window.clone();
        main_window.on_window_event(move |event| {
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    let main_pos = match main.inner_position() {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    let panes = match registry.panes.read() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    for handle in panes.values() {
                        let rect = match handle.stored_rect.read() {
                            Ok(r) => *r,
                            Err(_) => continue,
                        };
                        let _ = handle.window.set_position(PhysicalPosition::new(
                            main_pos.x + rect.x,
                            main_pos.y + rect.y,
                        ));
                        let _ = handle.window.set_size(LogicalSize::new(
                            rect.w as f64,
                            rect.h as f64,
                        ));
                    }
                }
                _ => {}
            }
        });
        log::info!("[pkg_webview] parent-window event listener installed");
    }

    pub fn statuses(&self) -> Vec<WebviewPaneStatus> {
        let g = match self.panes.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        g.iter()
            .map(|((pkg_id, pane_id), h)| {
                let live_position = h
                    .window
                    .outer_position()
                    .ok()
                    .map(|p| [p.x as i32, p.y as i32]);
                let live_size = h.window.outer_size().ok().map(|s| [s.width, s.height]);
                let stored_rect = h.stored_rect.read().ok().map(|r| *r).unwrap_or(PaneRect {
                    x: 0,
                    y: 0,
                    w: 0,
                    h: 0,
                });
                WebviewPaneStatus {
                    pkg_id: pkg_id.clone(),
                    pane_id: pane_id.clone(),
                    webview_label: h.label.clone(),
                    current_url: h.current_url.read().ok().and_then(|c| c.clone()),
                    partition: h.partition.clone(),
                    stored_rect,
                    live_position,
                    live_size,
                }
            })
            .collect()
    }
}

impl Registry for WebviewPanesRegistry {
    fn name(&self) -> &'static str {
        "webview_panes"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        let cap = pkg
            .manifest
            .capabilities
            .as_ref()
            .and_then(|c| c.webview.as_ref())
            .map(|w| PkgCapability {
                child_webviews: w.child_webviews,
                partitions: w.partitions.clone(),
            })
            .unwrap_or_default();
        self.pkg_capabilities
            .write()
            .map_err(|_| anyhow!("pkg_capabilities lock poisoned"))?
            .insert(pkg.manifest.id.clone(), cap);
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let keys: Vec<_> = self
            .panes
            .read()
            .map(|g| {
                g.keys()
                    .filter(|(p, _)| p == pkg_id)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (pkg, pane) in keys {
            if let Err(e) = self.destroy(&pkg, &pane) {
                log::warn!("[pkg_webview] unregister cleanup for ({pkg},{pane}) failed: {e}");
            }
        }
        self.pkg_capabilities
            .write()
            .map_err(|_| anyhow!("pkg_capabilities lock poisoned"))?
            .remove(pkg_id);
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let entries = self.statuses();
        serde_json::json!({
            "count": entries.len(),
            "entries": entries,
        })
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn webview_label(pkg_id: &str, pane_id: &str) -> String {
    let pkg_slug = pkg_id.replace('.', "-");
    let pane_slug: String = pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    format!("pkg-{pkg_slug}-{pane_slug}")
}

fn partition_dir(app: &AppHandle, pkg_id: &str, partition: &str) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("app_data_dir: {e}"))?;
    let pkg_slug = pkg_id.replace('.', "-");
    Ok(base.join("webjars").join(pkg_slug).join(partition))
}

// `LogicalPosition` import kept for set_rect's macOS-friendly logical-size
// path; the kernel mixes logical sizes (FE-friendly) with physical positions
// (Tauri's outer_position contract) which is the boundary translation
// `set_position(PhysicalPosition)` + `set_size(LogicalSize)` formalizes.
#[allow(dead_code)]
fn _logical_position_used(_: LogicalPosition<f64>) {}
