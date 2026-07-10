//! Window registry — owns the lifecycle of spawned windows (plans/multi-window
//! WP-03). Consumes the WP-02 `G-WINDOW-MODEL` contract.
//!
//! Each non-primary window is created with a [`WindowDescriptor`]-derived label
//! and tracked here. The registry emits the canonical `window://` lifecycle
//! events (via the contract envelope) and exposes a window-targeted emit helper
//! (`emit_to_window`) — the race-free path for `WINDOW_TARGETED_CHANNELS`.

use std::collections::HashMap;
use std::sync::RwLock;

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::descriptor::{WindowDescriptor, WindowKind};
use super::events::{topics, WindowEventEnvelope, WindowEventTarget};

/// Process-global registry of spawned (non-`main`) windows. Managed in Tauri
/// state; the primary `main` window is owned by `lib.rs` setup and is not held
/// here.
#[derive(Default)]
pub struct WindowRegistry {
    inner: RwLock<HashMap<String, WindowDescriptor>>,
}

fn kind_str(kind: &WindowKind) -> &'static str {
    match kind {
        WindowKind::Primary => "primary",
        WindowKind::SingleSurface => "single-surface",
        WindowKind::PaneSet => "pane-set",
        WindowKind::Workspace => "workspace",
    }
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a labeled window from a descriptor. The window loads the same app
    /// URL as `main` with `?window=<label>&surfaces=…` appended; WP-05's thin
    /// entry reads those params to mount only the declared surface_set.
    pub fn spawn(&self, app: &AppHandle, desc: WindowDescriptor) -> Result<String> {
        if desc.label == "main" {
            return Err(anyhow!("'main' is the primary window and cannot be spawned"));
        }
        if self.inner.read().unwrap().contains_key(&desc.label)
            || app.get_webview_window(&desc.label).is_some()
        {
            return Err(anyhow!("window '{}' already exists", desc.label));
        }

        // Derive the URL from the primary window so dev (localhost:1420) and
        // prod (viewer_port) both work without re-plumbing the port here.
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("no primary window yet"))?;
        let mut url = main.url().map_err(|e| anyhow!("read main url: {e}"))?;
        {
            let mut qp = url.query_pairs_mut();
            qp.clear();
            qp.append_pair("window", &desc.label);
            qp.append_pair("kind", kind_str(&desc.kind));
            // One repeated `surfaces` param per entry — do NOT comma-join: a
            // surface id can legally contain a comma (e.g. `viewer:/a/b,c.md`),
            // which a comma-split on the FE would fracture. The FE reads them
            // with `params.getAll('surfaces')`.
            for s in &desc.surface_set {
                qp.append_pair("surfaces", s);
            }
            if let Some(p) = &desc.project_id {
                qp.append_pair("project", p);
            }
        }

        let window =
            WebviewWindowBuilder::new(app, &desc.label, WebviewUrl::External(url))
                .title("Ikenga")
                .inner_size(960.0, 700.0)
                .min_inner_size(480.0, 360.0)
                .resizable(true)
                .disable_drag_drop_handler()
                .build()
                .map_err(|e| anyhow!("build window '{}': {e}", desc.label))?;

        self.inner
            .write()
            .unwrap()
            .insert(desc.label.clone(), desc.clone());

        // Cleanup + closed event when the OS window is destroyed (user close),
        // plus focus-changed on every focus transition (part of the frozen
        // window contract the FE cross-window bus subscribes to).
        let app_for_close = app.clone();
        let label_for_close = desc.label.clone();
        window.on_window_event(move |ev| match ev {
            WindowEvent::Destroyed => {
                if let Some(reg) = app_for_close.try_state::<WindowRegistry>() {
                    reg.inner.write().unwrap().remove(&label_for_close);
                }
                // A pkg pane parented to this window would otherwise leak in the
                // panes map (macOS/Windows) or as a top-level surface + listener
                // entry (Linux) until pkg uninstall.
                cleanup_panes_for_parent(&app_for_close, &label_for_close);
                let env = WindowEventEnvelope::new(
                    topics::CLOSED,
                    "core",
                    WindowEventTarget::Broadcast,
                    serde_json::json!({ "label": label_for_close }),
                );
                let _ = app_for_close.emit(topics::CLOSED, env);
            }
            WindowEvent::Focused(focused) => {
                emit_focus_changed(&app_for_close, &label_for_close, *focused);
            }
            _ => {}
        });

        let opened = WindowEventEnvelope::new(
            topics::OPENED,
            "core",
            WindowEventTarget::Broadcast,
            serde_json::json!({ "label": desc.label, "kind": kind_str(&desc.kind) }),
        );
        let _ = app.emit(topics::OPENED, opened);

        Ok(desc.label)
    }

    /// Close a spawned window by label. `main` is refused.
    pub fn close(&self, app: &AppHandle, label: &str) -> Result<()> {
        if label == "main" {
            return Err(anyhow!("cannot close the primary window"));
        }
        if let Some(w) = app.get_webview_window(label) {
            w.close().map_err(|e| anyhow!("close '{label}': {e}"))?;
        }
        // The Destroyed handler also removes it, but remove here too so a
        // close() immediately reflects in list() even before the event fires.
        self.inner.write().unwrap().remove(label);
        Ok(())
    }

    /// Descriptors of all currently-spawned windows (raw in-memory view; may
    /// contain a ghost if a `Destroyed` event was missed). Prefer `list_live`
    /// wherever an `AppHandle` is available.
    pub fn list(&self) -> Vec<WindowDescriptor> {
        self.inner.read().unwrap().values().cloned().collect()
    }

    /// Like `list`, but reconciles against the OS: any tracked label that no
    /// longer resolves via `get_webview_window` is dropped (and its panes /
    /// listeners cleaned up), so a missed `Destroyed` event can't leave a
    /// permanent ghost in the registry.
    pub fn list_live(&self, app: &AppHandle) -> Vec<WindowDescriptor> {
        let dead: Vec<String> = {
            let g = self.inner.read().unwrap();
            g.keys()
                .filter(|label| app.get_webview_window(label).is_none())
                .cloned()
                .collect()
        };
        if !dead.is_empty() {
            {
                let mut g = self.inner.write().unwrap();
                for label in &dead {
                    g.remove(label);
                }
            }
            for label in &dead {
                tracing::warn!(
                    "[window] reconciled ghost window `{label}` (Destroyed event missed)"
                );
                cleanup_panes_for_parent(app, label);
                let env = WindowEventEnvelope::new(
                    topics::CLOSED,
                    "core",
                    WindowEventTarget::Broadcast,
                    serde_json::json!({ "label": label }),
                );
                let _ = app.emit(topics::CLOSED, env);
            }
        }
        self.inner.read().unwrap().values().cloned().collect()
    }

    /// Window-targeted emit — the race-free path for `WINDOW_TARGETED_CHANNELS`
    /// (vs broadcast `app.emit`). WP-04 migrates the racy existing channels here.
    #[allow(dead_code)]
    pub fn emit_to_window<T: Serialize + Clone>(
        &self,
        app: &AppHandle,
        label: &str,
        topic: &str,
        payload: T,
    ) -> Result<()> {
        app.emit_to(label, topic, payload)
            .map_err(|e| anyhow!("emit_to '{label}': {e}"))
    }
}

/// Emit `topic` to the currently-focused window only, falling back to a
/// broadcast if no window reports focus. Used for global-shortcut-driven
/// events (`screenshot://shortcut`) that must reach the window the user is
/// looking at, not race across every window (research 03 — the broadcast
/// shortcut made every window's screenshot listener respond simultaneously).
/// Emit to a specific window label, falling back to a broadcast if no window
/// with that label exists. Use this when a topic has exactly ONE consumer
/// window (e.g. `screenshot://shortcut`, whose FE listener lives only in the
/// primary window) — `emit_to_focused` would mis-route to a focused pkg-pane /
/// detached window that has no listener.
pub fn emit_to_label<T: Serialize + Clone>(
    app: &AppHandle,
    label: &str,
    topic: &str,
    payload: T,
) -> Result<()> {
    if app.get_webview_window(label).is_some() {
        app.emit_to(label, topic, payload)
            .map_err(|e| anyhow!("emit_to '{label}': {e}"))
    } else {
        app.emit(topic, payload)
            .map_err(|e| anyhow!("broadcast '{topic}': {e}"))
    }
}

// Superseded for the screenshot shortcut by `focused_listener_window_label` +
// `emit_to_label` (this walks ALL `webview_windows`, which mis-routes to focused
// pkg-pane child webviews on Linux). Kept as the generic WP-04 primitive.
#[allow(dead_code)]
pub fn emit_to_focused<T: Serialize + Clone>(
    app: &AppHandle,
    topic: &str,
    payload: T,
) -> Result<()> {
    let focused = app.webview_windows().into_iter().find_map(|(label, w)| {
        if w.is_focused().unwrap_or(false) {
            Some(label)
        } else {
            None
        }
    });
    match focused {
        Some(label) => app
            .emit_to(&label, topic, payload)
            .map_err(|e| anyhow!("emit_to '{label}': {e}")),
        None => app
            .emit(topic, payload)
            .map_err(|e| anyhow!("broadcast '{topic}': {e}")),
    }
}

/// Emit the canonical `window://focus-changed` broadcast for `label`. Called
/// from every window's `Focused` hook (main in `lib.rs` setup, detached in
/// `spawn`). Broadcast (not window-targeted) — focus-changed isn't in
/// `WINDOW_TARGETED_CHANNELS`; each window filters its own subscription.
pub fn emit_focus_changed(app: &AppHandle, label: &str, focused: bool) {
    let env = WindowEventEnvelope::new(
        topics::FOCUS_CHANGED,
        "core",
        WindowEventTarget::Broadcast,
        serde_json::json!({ "label": label, "focused": focused }),
    );
    let _ = app.emit(topics::FOCUS_CHANGED, env);
}

/// Label of the currently-focused window that actually hosts the screenshot
/// listener (`useScreenshotListener`, mounted only inside `<Workspace/>`).
///
/// Only `Workspace`-kind spawned windows qualify: `single-surface` / `pane-set`
/// detached windows render the thin `DetachedRoot` (no listener), and pkg-pane
/// child webviews (Linux `TopLevel` surfaces) also appear in
/// `app.webview_windows()` but carry no shell listeners — routing a shortcut to
/// either silently no-ops (the `emit_to_focused` regression pinned to "main" in
/// 86a766a). Returns `None` when no such window is focused — including whenever
/// `main` itself is focused, or when WebKitGTK's `is_focused` under-reports — so
/// the caller falls back to "main", preserving today's behavior exactly.
pub fn focused_listener_window_label(app: &AppHandle) -> Option<String> {
    let reg = app.try_state::<WindowRegistry>()?;
    reg.list()
        .into_iter()
        .filter(|d| matches!(d.kind, WindowKind::Workspace))
        .map(|d| d.label)
        .find(|label| {
            app.get_webview_window(label)
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false)
        })
}

/// Tear down any pkg-webview panes parented to a now-destroyed window. Bridges
/// the window registry to `WebviewPanesRegistry` without either owning the
/// other; a no-op if the panes state isn't managed yet (early boot).
fn cleanup_panes_for_parent(app: &AppHandle, parent_label: &str) {
    if let Some(panes) = app.try_state::<crate::commands::pkg_webview::WebviewPanesState>() {
        panes.0.cleanup_for_parent(parent_label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_empty_on_new() {
        let reg = WindowRegistry::new();
        assert!(reg.list().is_empty());
    }

    #[test]
    fn kind_str_matches_contract_kebab_case() {
        assert_eq!(kind_str(&WindowKind::SingleSurface), "single-surface");
        assert_eq!(kind_str(&WindowKind::Workspace), "workspace");
    }
}
