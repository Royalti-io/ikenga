//! UI routes registry — declarative routes a package contributes to the
//! shell's content pane.
//!
//! v1 scope: route entries are stored and surfaced via the kernel snapshot so
//! a future "Installed Apps" sidebar / route resolver can iterate them. We do
//! NOT actually mount the iframe in the shell yet — that wires up when the
//! first windowed app needs it. `kind: "iframe"` is honoured at register time
//! (recorded), `kind: "component"` is also recorded but tagged so the FE can
//! choose to hide unmountable routes today.
//!
//! Path namespacing: every registered route ends up keyed as
//! `pkg://<pkg_id><path>`. The `path` field in the manifest must be absolute
//! within the package's namespace (start with `/`). Cross-package collisions
//! are rejected on register.

use std::collections::HashMap;
use std::sync::RwLock;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

#[derive(Debug, Clone, Serialize)]
pub struct UiRouteEntry {
    pub pkg_id: String,
    /// `pkg://<pkg_id><path>` — the canonical key.
    pub virtual_path: String,
    pub path: String,
    pub kind: String,
    pub source: String,
}

#[derive(Default)]
pub struct UiRoutesRegistry {
    /// Keyed by `virtual_path` (globally unique).
    entries: RwLock<HashMap<String, UiRouteEntry>>,
}

impl UiRoutesRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up a registered route by its virtual path. Returned entry can be
    /// inspected for `kind` to decide between iframe-mount and (future)
    /// component-mount.
    #[allow(dead_code)]
    pub fn resolve(&self, virtual_path: &str) -> Option<UiRouteEntry> {
        self.entries.read().ok()?.get(virtual_path).cloned()
    }

    pub fn list(&self) -> Vec<UiRouteEntry> {
        self.entries
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }
}

impl Registry for UiRoutesRegistry {
    fn name(&self) -> &'static str {
        "ui_routes"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        let block = match &pkg.manifest.ui {
            Some(b) if !b.routes.is_empty() => b,
            _ => return Ok(()),
        };

        let mut new_entries: Vec<UiRouteEntry> = Vec::with_capacity(block.routes.len());
        for r in &block.routes {
            if !r.path.starts_with('/') {
                return Err(anyhow!(
                    "ui route `{}` of `{}` must start with `/`",
                    r.path,
                    pkg.manifest.id
                ));
            }
            // `webview` is the kind for kernel-owned native child webviews
            // (pkg-browser). Validation is shared with `iframe`/`component`
            // here; the FE catch-all branches on kind at mount time and the
            // capability check happens in `WebviewPanesRegistry::create`.
            // See `pkg/webview.rs` and Phase 1 notes in `CLAUDE.md`.
            if r.kind != "iframe" && r.kind != "component" && r.kind != "webview" {
                return Err(anyhow!(
                    "ui route `{}` kind must be `iframe`, `component`, or `webview` (got `{}`)",
                    r.path,
                    r.kind
                ));
            }
            let virtual_path = format!("pkg://{}{}", pkg.manifest.id, r.path);
            new_entries.push(UiRouteEntry {
                pkg_id: pkg.manifest.id.clone(),
                virtual_path,
                path: r.path.clone(),
                kind: r.kind.clone(),
                source: r.source.clone(),
            });
        }

        let mut entries = self
            .entries
            .write()
            .map_err(|_| anyhow!("ui_routes lock poisoned"))?;
        for e in &new_entries {
            if let Some(existing) = entries.get(&e.virtual_path) {
                if existing.pkg_id != e.pkg_id {
                    return Err(anyhow!(
                        "ui route `{}` already registered by `{}`",
                        e.virtual_path,
                        existing.pkg_id
                    ));
                }
            }
        }
        for e in new_entries {
            entries.insert(e.virtual_path.clone(), e);
        }
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| anyhow!("ui_routes lock poisoned"))?;
        entries.retain(|_, e| e.pkg_id != pkg_id);
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let entries = self.list();
        json!({ "count": entries.len(), "entries": entries })
    }
}
