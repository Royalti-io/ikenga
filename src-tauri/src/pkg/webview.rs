//! Per-pkg child webview kernel.
//!
//! Owns the `(pkg_id, pane_id) → tauri::Webview` mapping and the per-jar
//! cookie partition resolution. Tauri commands in `commands/pkg_webview.rs`
//! are thin wrappers around the methods here.
//!
//! ## Lifecycle
//!
//! - **register** (kernel `Registry`): no-op. Webviews are created on
//!   demand when the frontend mounts a `kind = "webview"` route, not at
//!   pkg install time. The registry exists to enforce cleanup on
//!   uninstall — see `unregister`.
//! - **create** (FE-triggered): allocate a stable label
//!   `pkg-<pkg-slug>-<pane-slug>`, resolve the partition's data store
//!   (per-OS, see below), call `Window::add_child` against the main
//!   window with `WebviewBuilder::new(label, External(url))`. Track the
//!   resulting `tauri::Webview` handle in `panes`.
//! - **destroy** (FE-triggered or pkg uninstall): close the webview and
//!   drop it from the map. Cookie partition data persists on disk so a
//!   future create with the same partition name picks up the same jar.
//! - **navigate / eval / set_rect**: thin pass-through to `tauri::Webview`
//!   methods; each takes a `keep_awake::InflightGuard` at the call site
//!   so background-eval throttling is inhibited on macOS / Windows.
//!
//! ## Cookie partition resolution
//!
//! Per-pkg, per-partition isolation. The partition path / id is derived
//! deterministically from `(pkg_id, partition_name)` so a re-create after
//! restart picks up the same cookies, localStorage, etc.
//!
//! - **Linux (WebKitGTK) + Windows (WebView2)**: `data_directory(PathBuf)`
//!   on `WebviewBuilder`. Path: `app_data_dir/webjars/<pkg-slug>/<partition>/`.
//! - **macOS 14+ (WKWebView)**: `data_store_identifier([u8; 16])` on
//!   `WebviewBuilder`. The 16-byte id is `sha256(pkg_id || '/' ||
//!   partition_name)[..16]` — collision-resistant within the app.
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
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

/// Rect passed across the Tauri command boundary in window-client coordinates.
/// Integer fields; the FE rounds `getBoundingClientRect()` before sending.
#[derive(Debug, Clone, Copy, serde::Deserialize, Serialize)]
pub struct PaneRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Snapshot row surfaced via `Registry::snapshot` into `pkg_kernel_status`.
#[derive(Debug, Clone, Serialize)]
pub struct WebviewPaneStatus {
    pub pkg_id: String,
    pub pane_id: String,
    pub webview_label: String,
    pub current_url: Option<String>,
    pub partition: String,
}

struct PaneHandle {
    webview: Webview,
    label: String,
    partition: String,
    current_url: RwLock<Option<String>>,
}

#[derive(Default)]
pub struct WebviewPanesRegistry {
    /// `(pkg_id, pane_id) → handle`. Read locks for navigate/eval/set_rect;
    /// write lock only for create / destroy / unregister.
    panes: RwLock<HashMap<(String, String), Arc<PaneHandle>>>,
    /// Per-pkg cached capability — populated on `register`, read on `create`
    /// so we don't have to walk `pkg_installed` for every create.
    pkg_capabilities: RwLock<HashMap<String, PkgCapability>>,
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
        &self,
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

        let window = app
            .get_window("main")
            .ok_or_else(|| anyhow!("no main window — kernel called before setup completed?"))?;

        let label = webview_label(pkg_id, pane_id);
        let parsed_url = url::Url::parse(url).with_context(|| format!("parse url `{url}`"))?;

        // Per-OS partition wiring. Linux/Windows use a path; macOS uses a
        // stable 16-byte id derived from sha256(pkg_id + "/" + partition).
        let data_dir = partition_dir(app, pkg_id, partition)?;
        std::fs::create_dir_all(&data_dir).with_context(|| {
            format!("create webview data dir {}", data_dir.display())
        })?;

        // Build the WebviewBuilder. `_builder` is mutated under cfg below to
        // attach the macOS data-store identifier; the assignment back through
        // `let builder = ...` keeps the chained-builder pattern type-stable
        // because the `data_store_identifier` method on macOS returns the
        // same generic-parameterized type.
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
            .auto_resize() // keep child rect proportional under parent resize
            .data_directory(data_dir)
            .on_page_load(move |webview, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    log::debug!(
                        "[pkg_webview] `{}` page_load_finished url={}",
                        webview.label(),
                        payload.url()
                    );
                }
            });

        #[cfg(target_os = "macos")]
        {
            // macOS WKWebView ignores `data_directory`; isolation goes through
            // `WKWebsiteDataStore` keyed by a 16-byte identifier. Derive it
            // deterministically from (pkg_id, partition) so the same pair
            // resolves to the same store across restarts.
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

        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(rect.x as f64, rect.y as f64),
                LogicalSize::new(rect.w as f64, rect.h as f64),
            )
            .with_context(|| format!("add_child {label}"))?;

        let handle = Arc::new(PaneHandle {
            webview,
            label: label.clone(),
            partition: partition.to_string(),
            current_url: RwLock::new(Some(url.to_string())),
        });
        self.panes
            .write()
            .map_err(|_| anyhow!("panes lock poisoned"))?
            .insert((pkg_id.to_string(), pane_id.to_string()), handle);

        log::info!(
            "[pkg_webview] created `{label}` pkg={pkg_id} pane={pane_id} partition={partition} url={url}"
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
            // Best-effort close — log and continue on error so callers can't
            // get stuck if the webview is already gone (race with window close).
            if let Err(e) = handle.webview.close() {
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
            .webview
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
        // Windows: re-assert IsVisible per eval. macOS keep-awake is handled
        // by the caller's InflightGuard. Linux: no-op.
        let _ = crate::pkg::keep_awake::pin_visible(&handle.webview);
        handle
            .webview
            .eval(js)
            .with_context(|| format!("eval into `{}`", handle.label))?;
        Ok(())
    }

    pub fn set_rect(&self, pkg_id: &str, pane_id: &str, rect: PaneRect) -> Result<()> {
        let handle = self
            .lookup(pkg_id, pane_id)
            .ok_or_else(|| anyhow!("no webview pane for ({pkg_id}, {pane_id})"))?;
        handle
            .webview
            .set_position(LogicalPosition::new(rect.x as f64, rect.y as f64))
            .with_context(|| format!("set_position `{}`", handle.label))?;
        handle
            .webview
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

    pub fn statuses(&self) -> Vec<WebviewPaneStatus> {
        let g = match self.panes.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        g.iter()
            .map(|((pkg_id, pane_id), h)| WebviewPaneStatus {
                pkg_id: pkg_id.clone(),
                pane_id: pane_id.clone(),
                webview_label: h.label.clone(),
                current_url: h.current_url.read().ok().and_then(|c| c.clone()),
                partition: h.partition.clone(),
            })
            .collect()
    }
}

impl Registry for WebviewPanesRegistry {
    fn name(&self) -> &'static str {
        "webview_panes"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        // Cache the capability so `create` doesn't need to walk back to
        // the manifest each time. Absent block → all-false defaults, which
        // means subsequent `create` rejects with a clear error.
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
        // Drop every active webview owned by this pkg. Cookie partition
        // data on disk is intentionally NOT removed — a re-install of the
        // same pkg picks up the same logged-in sessions, same as
        // uninstall/reinstall behavior in normal browsers.
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

// macOS `data_store_identifier` is applied inline in `create()` under
// `#[cfg(target_os = "macos")]` — see the create method body. A separate
// helper was tried but ran into WebviewBuilder generics (parameterized over
// the Tauri Runtime), and inlining keeps the type chain clean.
