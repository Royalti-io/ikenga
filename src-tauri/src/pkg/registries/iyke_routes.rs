//! Iyke routes registry — packages declare HTTP endpoints under
//! `/pkg/<id>/...` that the iyke axum server dispatches via this registry's
//! lookup table. The host's own `/iyke/*` routes stay statically wired in
//! `iyke/server.rs`; only `/pkg/*` is registry-driven.
//!
//! Handlers supported today:
//!   - `Echo` — returns the request body verbatim. Useful for testing the
//!     wiring end-to-end without depending on a real handler.
//!   - `EventEmit { name }` — emits a Tauri event (`pkg://<name>`) with the
//!     request body as payload, returns 202. Lets a package CLI driver push
//!     state changes into the running webview.
//!
//! Sidecar handler (`Sidecar { name, subcommand }`) is declared in the
//! manifest but not yet wired — it requires the SidecarsRegistry's resolve
//! API plus a streaming spawn. Lands when the first package needs it.
//!
//! Path namespacing: every package route is registered as
//! `(method, "/pkg/<id>/<rest>")`. The package can't grab `/iyke/*` or any
//! other namespace — uniqueness check at register time uses the full path.

use std::collections::HashMap;
use std::sync::RwLock;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::pkg::manifest::{IykeRoute as ManifestRoute, Package};
use crate::pkg::registry::Registry;

#[derive(Debug, Clone, Serialize)]
pub enum Handler {
    Echo,
    EventEmit { name: String },
    Sidecar { name: String, subcommand: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteEntry {
    pub pkg_id: String,
    pub method: String,
    pub path: String,
    pub handler: Handler,
}

pub type Method = String; // "GET" | "POST" | ... — uppercased at register time

#[derive(Default)]
pub struct IykeRoutesRegistry {
    /// Keyed by `(METHOD, path)`. Methods are uppercased; paths are exact
    /// (no glob support yet).
    routes: RwLock<HashMap<(Method, String), RouteEntry>>,
}

impl IykeRoutesRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up the handler for a given (method, path). Called from the iyke
    /// server's catch-all `/pkg/{*path}` route.
    pub fn resolve(&self, method: &str, path: &str) -> Option<RouteEntry> {
        let key = (method.to_ascii_uppercase(), path.to_string());
        self.routes.read().ok()?.get(&key).cloned()
    }

    /// All routes — used by the kernel-status snapshot.
    pub fn list(&self) -> Vec<RouteEntry> {
        self.routes
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    fn parse_handler(spec: &str) -> Result<Handler> {
        // Format: "echo" | "event:<name>" | "sidecar:<name> <subcommand>"
        let spec = spec.trim();
        if spec == "echo" {
            return Ok(Handler::Echo);
        }
        if let Some(rest) = spec.strip_prefix("event:") {
            let name = rest.trim();
            if name.is_empty() {
                return Err(anyhow!("event handler missing name"));
            }
            return Ok(Handler::EventEmit { name: name.into() });
        }
        if let Some(rest) = spec.strip_prefix("sidecar:") {
            let mut parts = rest.trim().splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or("").trim();
            let sub = parts.next().unwrap_or("").trim();
            if name.is_empty() || sub.is_empty() {
                return Err(anyhow!(
                    "sidecar handler must be `sidecar:<name> <subcommand>`"
                ));
            }
            return Ok(Handler::Sidecar {
                name: name.into(),
                subcommand: sub.into(),
            });
        }
        Err(anyhow!(
            "unknown handler `{spec}` (use `echo`, `event:<name>`, or `sidecar:<name> <sub>`)"
        ))
    }

    fn validate_path(pkg_id: &str, path: &str) -> Result<String> {
        let expected_prefix = format!("/pkg/{pkg_id}/");
        if !path.starts_with(&expected_prefix) && path != format!("/pkg/{pkg_id}") {
            return Err(anyhow!(
                "iyke route path `{path}` must start with `{expected_prefix}` (or equal `/pkg/{pkg_id}`)"
            ));
        }
        Ok(path.to_string())
    }
}

impl Registry for IykeRoutesRegistry {
    fn name(&self) -> &'static str {
        "iyke_routes"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        let block = match &pkg.manifest.iyke {
            Some(b) => b,
            None => return Ok(()),
        };
        if block.routes.is_empty() {
            return Ok(());
        }

        // Build the new entries first so a single bad route aborts cleanly.
        let mut new_entries: Vec<RouteEntry> = Vec::with_capacity(block.routes.len());
        for r in &block.routes {
            let ManifestRoute { method, path, handler } = r;
            let method_upper = method.to_ascii_uppercase();
            if method_upper != "GET" && method_upper != "POST" {
                return Err(anyhow!(
                    "iyke route method must be GET or POST (got `{method}` for `{path}`)"
                ));
            }
            let path = Self::validate_path(&pkg.manifest.id, path)?;
            let handler = Self::parse_handler(handler)?;
            new_entries.push(RouteEntry {
                pkg_id: pkg.manifest.id.clone(),
                method: method_upper,
                path,
                handler,
            });
        }

        // Atomic apply with collision check.
        let mut routes = self
            .routes
            .write()
            .map_err(|_| anyhow!("iyke_routes lock poisoned"))?;
        for e in &new_entries {
            let key = (e.method.clone(), e.path.clone());
            if let Some(existing) = routes.get(&key) {
                if existing.pkg_id != e.pkg_id {
                    return Err(anyhow!(
                        "iyke route `{} {}` already registered by `{}`",
                        e.method,
                        e.path,
                        existing.pkg_id
                    ));
                }
            }
        }
        for e in new_entries {
            routes.insert((e.method.clone(), e.path.clone()), e);
        }
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let mut routes = self
            .routes
            .write()
            .map_err(|_| anyhow!("iyke_routes lock poisoned"))?;
        routes.retain(|_, e| e.pkg_id != pkg_id);
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let entries = self.list();
        json!({ "count": entries.len(), "entries": entries })
    }
}
