//! Per-pane Chrome-engine registry + dispatch state for `/iyke/browser/*`
//! (WP-07). The *parallel kernel* for `engine = "chrome"`.
//!
//! ## Why this exists
//!
//! The existing `/iyke/browser/*` handlers (`browser_handlers.rs`) address a
//! pane by `(pkg_id, pane_id)` and drive a WebKit child-webview through
//! `WebviewPanesRegistry`. `engine = "chrome"` (Managed mode) is a *parallel
//! kernel sharing only the API*: a separate Chrome OS process driven over CDP
//! via `chromiumoxide`, with its own ref store and no shell-pane rect. It
//! transfers nothing from the WebKit registry.
//!
//! So WP-07 needs two things:
//!  1. a record of **which `(pkg_id, pane_id)` is chrome vs webkit**, decided at
//!     `/open` time and consulted by every subsequent verb (actions address a
//!     pane by id and must inherit its engine);
//!  2. the **live Chrome state** for each chrome pane: the launched
//!     [`ManagedChrome`], the active [`chromiumoxide::Page`] we drive, the
//!     latest [`RefStore`], and the process state.
//!
//! Both live in [`ChromeEngineRegistry`], a single `Extension`-injected,
//! `Arc`-shared, async-locked map. The WebKit path never touches it; a verb
//! dispatches to Chrome **only** when this registry says the pane is chrome.
//!
//! ## The `Page` is load-bearing
//!
//! Every WP-06 action verb (`actions::{goto, click, fill, …}`) takes a
//! `&chromiumoxide::Page`, not a `&Browser`. So [`ChromePane`] holds a cloned
//! `Page` (chromiumoxide `Page` is `Clone` — Arc-backed) captured at `/open`
//! from `managed.browser.pages()` (or a fresh `new_page(url)`), and every verb
//! drives that page. Without it, zero verbs are implementable.
//!
//! ## Wire shape is identical
//!
//! Every Chrome handler returns the *same JSON* the WebKit handler returns
//! (`{ ok: true }` for interactions, the snapshot `Value` with `id`/`snapshotId`
//! folded in, etc.). The `engine` field that gates dispatch is the only
//! addition. Agents see one surface.
//!
//! ## Verb applicability (G-05)
//!
//! For `engine = "chrome"` (external OS window, no shell-pane rect):
//!  - `/open` ignores `rect`, launches Chrome, records the pane;
//!  - `/focus` → CDP `Page.bringToFront` (not shell-pane focus);
//!  - `/resize` (`set_rect`) → no-op; geometry is null in `/list`;
//!  - `/screenshot` → `Page.captureScreenshot` (the WebKit `501` now satisfied);
//!  - `/list` rows carry `engine:"chrome"` + the `ChromeState` process state +
//!    null geometry.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chromiumoxide::Page;
use tokio::sync::Mutex;

use crate::pkg::chrome::launcher::{launch_managed, LaunchOptions, ManagedChrome};
use crate::pkg::chrome::lifecycle::{record_launch, ChromeState};
use crate::pkg::chrome::snapshot::RefStore;

/// Engine backing a pane. Mirrors `@ikenga/contract` `BrowserEngine`
/// (`"webkit" | "chrome"`). `Default` = `Webkit` so an absent/unknown engine
/// reads as the legacy in-shell path (back-compat, matches the contract's
/// `.default('webkit')`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PaneEngine {
    #[default]
    Webkit,
    Chrome,
}

impl PaneEngine {
    /// Wire string for the engine. Part of the type's API; not yet on a hot path.
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            PaneEngine::Webkit => "webkit",
            PaneEngine::Chrome => "chrome",
        }
    }

    /// Parse the wire string. Unknown / absent → `Webkit` (contract default).
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("chrome") => PaneEngine::Chrome,
            _ => PaneEngine::Webkit,
        }
    }
}

/// Opaque kernel pane key, identical addressing to the WebKit path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PaneKeyOwned {
    pub pkg_id: String,
    pub pane_id: String,
}

impl PaneKeyOwned {
    pub fn new(pkg_id: &str, pane_id: &str) -> Self {
        Self {
            pkg_id: pkg_id.to_string(),
            pane_id: pane_id.to_string(),
        }
    }
}

/// Live state for one Chrome-engine pane. One [`ManagedChrome`] (process +
/// connected `Browser`) per pane in v1 — Managed mode is one dedicated
/// `--user-data-dir` per pane.
///
/// `page` is the CDP page handle every action verb drives (cloned at open;
/// `chromiumoxide::Page` is `Clone`/Arc-backed). `ref_store` is the latest
/// snapshot's ref→backend-id map (WP-05), replaced wholesale on each `/snapshot`
/// (the contract's "refs invalidate on the next snapshot" rule).
pub struct ChromePane {
    /// The launched + CDP-attached Chrome backing this pane. Owned so a `close`
    /// can deliberately reap the process; dropping it severs the CDP pump.
    /// Never read by name — held purely for that ownership/`Drop` side-effect.
    #[allow(dead_code)]
    pub managed: ManagedChrome,
    /// The CDP page handle WP-06 action verbs drive. Cloned from
    /// `managed.browser` at open. **Load-bearing** — without it no verb works.
    pub page: Page,
    /// Latest snapshot ref store. `None` until the first `/snapshot`.
    pub ref_store: Option<RefStore>,
    /// Monotonic snapshot counter for this pane (mirrors the WebKit/MCP
    /// `snapshotId` field).
    pub snapshot_id: u64,
    /// Process lifecycle state surfaced into `/list` (WP-04 `ChromeState`).
    pub state: ChromeState,
    /// The dedicated managed-profile name this pane was opened with (so a later
    /// reconcile can re-resolve the same `--user-data-dir`). Doubles as the
    /// `partition` surfaced in `/list`.
    pub profile_name: String,
    /// Whether the pane is paused (parity with the WebKit `paused` flag).
    pub paused: bool,
}

impl ChromePane {
    pub fn new(managed: ManagedChrome, page: Page, profile_name: String) -> Self {
        Self {
            managed,
            page,
            ref_store: None,
            snapshot_id: 0,
            state: ChromeState::Alive,
            profile_name,
            paused: false,
        }
    }
}

/// One `/list` row's worth of Chrome-pane status. Geometry is null for chrome
/// (G-05); `engine` is always `"chrome"`; `state` is the process state.
#[derive(Debug, Clone)]
pub struct ChromePaneStatus {
    pub pkg_id: String,
    pub pane_id: String,
    pub current_url: Option<String>,
    pub partition: String,
    pub engine: &'static str,
    pub state: &'static str,
    pub paused: bool,
}

/// The parallel Chrome kernel: which panes are chrome + their live state.
///
/// `Arc<Mutex<..>>` (async `tokio::sync::Mutex`) because the values hold a
/// `chromiumoxide::Browser` and the handlers driving them are async. We hold the
/// lock only briefly — to clone out the `Page` (cheap, Arc-backed) and the
/// latest `RefStore` — then release it *before* awaiting the CDP work, so a long
/// `wait_for` on one pane never blocks an action on another.
#[derive(Clone, Default)]
pub struct ChromeEngineRegistry {
    inner: Arc<Mutex<HashMap<PaneKeyOwned, ChromePane>>>,
}

impl ChromeEngineRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// True iff this pane is a chrome pane (the hot path the dispatch branches
    /// call at the top of each verb). Absence == WebKit fall-through.
    pub async fn is_chrome(&self, pkg_id: &str, pane_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .contains_key(&PaneKeyOwned::new(pkg_id, pane_id))
    }

    /// Engine of a pane. `None` = no chrome pane under this key (falls through
    /// to WebKit). `Some(Chrome)` otherwise. We never track WebKit panes here.
    /// Registry API exercised by tests; the hot dispatch path uses `is_chrome`.
    #[allow(dead_code)]
    pub async fn engine_of(&self, pkg_id: &str, pane_id: &str) -> Option<PaneEngine> {
        self.inner
            .lock()
            .await
            .get(&PaneKeyOwned::new(pkg_id, pane_id))
            .map(|_| PaneEngine::Chrome)
    }

    /// Launch + CDP-attach Managed Chrome for a freshly-opened chrome pane,
    /// capture its [`Page`], record the launch breadcrumb (WP-04), and insert
    /// it. Errors if the key already exists (caller should `close` first).
    ///
    /// `profile_name` resolves to the dedicated `--user-data-dir`; v1 uses one
    /// process per pane. `url` is opened in the captured page.
    pub async fn open(
        &self,
        pkg_id: &str,
        pane_id: &str,
        profile_name: &str,
        url: &str,
    ) -> Result<()> {
        let key = PaneKeyOwned::new(pkg_id, pane_id);
        {
            // Fail fast on a duplicate before we spend a Chrome launch.
            if self.inner.lock().await.contains_key(&key) {
                return Err(anyhow!(
                    "chrome pane ({pkg_id}, {pane_id}) already exists; close it first"
                ));
            }
        }

        let managed = launch_managed(LaunchOptions {
            profile_name: profile_name.to_string(),
            port: None,
            extra_args: Vec::new(),
        })
        .await?;

        // Breadcrumb so a later boot can reconcile/reattach instead of orphan.
        // Best-effort — a failed record write shouldn't sink the open.
        if let Err(e) = record_launch(&managed) {
            tracing::warn!("chrome open: record_launch failed: {e:#}");
        }

        // Capture the page to drive. A fresh managed Chrome opens with one
        // about:blank page; reuse it and navigate, else open a new one at `url`.
        let page = match managed.browser.pages().await {
            Ok(mut pages) if !pages.is_empty() => {
                let p = pages.remove(0);
                // Navigate the existing tab to the requested URL.
                let _ = crate::pkg::chrome::actions::goto(&p, url).await?;
                p
            }
            _ => managed.browser.new_page(url).await?,
        };

        let pane = ChromePane::new(managed, page, profile_name.to_string());
        let mut g = self.inner.lock().await;
        // Re-check under the final lock (open is async; a racing open could have
        // inserted while we were launching).
        if g.contains_key(&key) {
            return Err(anyhow!(
                "chrome pane ({pkg_id}, {pane_id}) already exists; close it first"
            ));
        }
        g.insert(key, pane);
        Ok(())
    }

    /// Remove a Chrome pane and return it so the caller can drive a clean
    /// teardown. Dropping the returned [`ChromePane`] severs the CDP attachment
    /// (the `ManagedChrome` `Drop` aborts the handler pump). v1 leaves the OS
    /// process to the lifecycle layer.
    pub async fn remove(&self, pkg_id: &str, pane_id: &str) -> Option<ChromePane> {
        self.inner
            .lock()
            .await
            .remove(&PaneKeyOwned::new(pkg_id, pane_id))
    }

    /// Clone out a pane's live `Page` (cheap, Arc-backed) without holding the
    /// map lock across the caller's CDP `.await`. Returns a 404-shaped error if
    /// the pane vanished (closed concurrently). This is what navigation /
    /// screenshot / focus verbs use — they need only the page.
    pub async fn page(&self, pkg_id: &str, pane_id: &str) -> Result<Page> {
        let g = self.inner.lock().await;
        g.get(&PaneKeyOwned::new(pkg_id, pane_id))
            .map(|p| p.page.clone())
            .ok_or_else(|| anyhow!("no chrome pane ({pkg_id}, {pane_id})"))
    }

    /// Clone out a pane's `Page` **and** its latest `RefStore` together, so an
    /// interaction verb (click/fill/select/press_key/read_text) can resolve a
    /// ref against the snapshot store while driving the page — all without
    /// holding the map lock across CDP awaits.
    pub async fn page_and_refs(
        &self,
        pkg_id: &str,
        pane_id: &str,
    ) -> Result<(Page, Option<RefStore>)> {
        let g = self.inner.lock().await;
        g.get(&PaneKeyOwned::new(pkg_id, pane_id))
            .map(|p| (p.page.clone(), p.ref_store.clone()))
            .ok_or_else(|| anyhow!("no chrome pane ({pkg_id}, {pane_id})"))
    }

    /// Persist a fresh `RefStore` (taken by `/snapshot`) as the pane's latest,
    /// bump + return the pane's monotonic `snapshot_id`. Errors if the pane
    /// vanished. This is the `update_snapshot` path the brief calls for.
    pub async fn update_snapshot(
        &self,
        pkg_id: &str,
        pane_id: &str,
        refs: RefStore,
    ) -> Result<u64> {
        let mut g = self.inner.lock().await;
        let pane = g
            .get_mut(&PaneKeyOwned::new(pkg_id, pane_id))
            .ok_or_else(|| anyhow!("no chrome pane ({pkg_id}, {pane_id})"))?;
        pane.ref_store = Some(refs);
        pane.snapshot_id += 1;
        Ok(pane.snapshot_id)
    }

    /// Snapshot of every chrome pane for the unified `/list`. Filtered by an
    /// optional `pkg_id` exactly like `get_browser_list` does for WebKit.
    pub async fn statuses(&self, pkg_filter: Option<&str>) -> Vec<ChromePaneStatus> {
        let g = self.inner.lock().await;
        g.iter()
            .filter(|(k, _)| pkg_filter.is_none_or(|p| p == k.pkg_id))
            .map(|(k, pane)| ChromePaneStatus {
                pkg_id: k.pkg_id.clone(),
                pane_id: k.pane_id.clone(),
                // current_url is read lazily by the dispatch branch (it holds
                // the Page); keeping this struct CDP-free avoids an await inside
                // the map lock.
                current_url: None,
                partition: pane.profile_name.clone(),
                engine: "chrome",
                state: pane.state.label(),
                paused: pane.paused,
            })
            .collect()
    }

    /// Set the paused flag (pause/resume verbs). Errors if the pane is absent.
    pub async fn set_paused(&self, pkg_id: &str, pane_id: &str, paused: bool) -> Result<()> {
        let mut g = self.inner.lock().await;
        let pane = g
            .get_mut(&PaneKeyOwned::new(pkg_id, pane_id))
            .ok_or_else(|| anyhow!("no chrome pane ({pkg_id}, {pane_id})"))?;
        pane.paused = paused;
        Ok(())
    }

    /// Read the paused flag (snapshot/interaction guard). Absent pane = not
    /// paused (the verb will then 404 in the page() lookup anyway).
    pub async fn is_paused(&self, pkg_id: &str, pane_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(&PaneKeyOwned::new(pkg_id, pane_id))
            .map(|p| p.paused)
            .unwrap_or(false)
    }

    /// Count of live chrome panes. Registry API exercised by tests.
    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_engine_parse_defaults_to_webkit() {
        assert_eq!(PaneEngine::parse(Some("chrome")), PaneEngine::Chrome);
        assert_eq!(PaneEngine::parse(Some("webkit")), PaneEngine::Webkit);
        assert_eq!(PaneEngine::parse(Some("unknown")), PaneEngine::Webkit);
        assert_eq!(PaneEngine::parse(None), PaneEngine::Webkit);
        assert_eq!(PaneEngine::default(), PaneEngine::Webkit);
    }

    #[test]
    fn pane_engine_as_str_roundtrips() {
        assert_eq!(PaneEngine::Chrome.as_str(), "chrome");
        assert_eq!(PaneEngine::Webkit.as_str(), "webkit");
    }

    #[test]
    fn pane_key_equality_is_by_both_components() {
        assert_eq!(PaneKeyOwned::new("a", "b"), PaneKeyOwned::new("a", "b"));
        assert_ne!(PaneKeyOwned::new("a", "b"), PaneKeyOwned::new("a", "c"));
    }

    #[tokio::test]
    async fn empty_registry_reports_webkit_for_unknown_pane() {
        let reg = ChromeEngineRegistry::new();
        assert!(!reg.is_chrome("pkg", "b1").await);
        assert_eq!(reg.engine_of("pkg", "b1").await, None);
        assert_eq!(reg.len().await, 0);
        assert!(reg.statuses(None).await.is_empty());
        assert!(!reg.is_paused("pkg", "b1").await);
        // Absent-pane mutations are 404-shaped, not panics.
        assert!(reg.set_paused("pkg", "b1", true).await.is_err());
        assert!(reg.update_snapshot("pkg", "b1", RefStore::default()).await.is_err());
        assert!(reg.page("pkg", "b1").await.is_err());
        assert!(reg.remove("pkg", "b1").await.is_none());
    }
}
