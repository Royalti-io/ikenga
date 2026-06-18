//! Rust-side `EngineAdapter` trait — ADR-012 Tracks D + P.
//!
//! The ADR talks about "installed `EngineAdapter`s" as a first-class kernel
//! concept (§3 "look up all installed `EngineAdapter` instances", §4
//! "writes the server's entry into each engine's external settings file").
//! This module is that concept: a tiny trait + a registry of concrete impls
//! the kernel fans MCP registration **and** asset fan-out through.
//!
//! For v1 the registry holds exactly one adapter — `ClaudeCodeAdapter`
//! (`engine_adapters/claude_code.rs`) — and it's registered statically at
//! kernel boot, independent of whether the `engine-claude-code` TS pkg is
//! loaded. The TS `ClaudeCodeEngineAdapter` from Track C remains useful for
//! in-pkg self-tests and future scenarios where engine pkgs ship adapters
//! dynamically; this Rust mirror is what the kernel actually dispatches
//! through today.
//!
//! Track P (this revision) extends the trait with folder-level asset
//! methods — `install_skills/commands/agents` and their uninstall inverses
//! — so the `engine_assets` registry can fan symlinks out over every
//! installed engine the same way `mcp.rs` already fans server entries out.
//! Gemini and Codex adapters (Tracks G + C) drop into the same trait
//! without further plumbing.
//!
//! Concurrency: adapter methods do disk I/O. `EngineAdaptersRegistry::iter`
//! snapshots the `Vec<Arc<dyn EngineAdapter>>` under a read lock and returns
//! the cloned Arcs so callers iterate without holding the lock.

use std::path::Path;
use std::sync::{Arc, RwLock};

use anyhow::Result;
use serde::Serialize;

use crate::pkg::manifest::McpServer;

/// One adapter's per-operation report. Surfaced to the pkg manager UI
/// (Track E) via the `McpRegistry` snapshot. `wrote` and `skipped` hold
/// stable string references (e.g. `<path>#<key>`) the UI can render;
/// `warnings` are non-fatal advisory messages.
#[derive(Debug, Clone, Default, Serialize)]
pub struct InstallReport {
    pub wrote: Vec<String>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
}

impl InstallReport {
    /// Merge `other` into `self`. Used when a single pkg has multiple MCP
    /// servers and the registry collects each per-server report into one
    /// per-(pkg, engine) bucket.
    pub fn merge(&mut self, other: InstallReport) {
        self.wrote.extend(other.wrote);
        self.skipped.extend(other.skipped);
        self.warnings.extend(other.warnings);
    }
}

/// A kernel-resident engine adapter. Concrete impls live under
/// `pkg::engine_adapters::*` and are registered at boot in
/// `lib.rs::run()::setup`.
///
/// Covers both MCP fan-out (Track D) and folder-asset fan-out (Track P).
/// The asset methods take an absolute source folder + the pkg's id/slug so
/// the adapter can materialize the folder into whatever location its engine
/// recognizes (symlink, copy, transcode). Idempotent by contract: a re-call
/// with the same source returns `InstallReport { skipped: [<target>], .. }`.
pub trait EngineAdapter: Send + Sync {
    /// Stable engine identifier — matches `engine.agentId` in the pkg
    /// manifest. v1 is exactly `"claude-code"`.
    fn id(&self) -> &'static str;

    /// Register one MCP server into this engine's external settings file.
    /// Idempotent: a re-register with byte-equal content returns
    /// `InstallReport { skipped: [<ref>], .. }` without touching disk.
    fn register_mcp_server(
        &self,
        server: &McpServer,
        pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport>;

    /// Remove one MCP server from this engine's settings file. Missing
    /// file / missing key are no-ops.
    fn unregister_mcp_server(&self, server_name: &str, pkg_id: &str, pkg_slug: &str) -> Result<()>;

    /// Materialize the pkg's `skills/` folder into this engine's recognized
    /// location. `folder` is the absolute path to the pkg's skills source.
    /// Idempotent — re-call with unchanged source returns `skipped`.
    fn install_skills(&self, folder: &Path, pkg_id: &str, pkg_slug: &str) -> Result<InstallReport>;

    /// Materialize the pkg's `commands/` folder. Engines without a native
    /// commands primitive may push warnings and otherwise no-op.
    fn install_commands(
        &self,
        folder: &Path,
        pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport>;

    /// Materialize the pkg's `agents/` folder. Some engines transcode the
    /// contents (Codex MD→TOML); others symlink the folder as-is.
    fn install_agents(&self, folder: &Path, pkg_id: &str, pkg_slug: &str) -> Result<InstallReport>;

    /// Inverse of `install_skills`. Removes only what this pkg owned.
    /// Missing target → no-op. Non-symlink target → warn + skip.
    fn uninstall_skills(&self, pkg_id: &str, pkg_slug: &str) -> Result<()>;

    /// Inverse of `install_commands`.
    fn uninstall_commands(&self, pkg_id: &str, pkg_slug: &str) -> Result<()>;

    /// Inverse of `install_agents`.
    fn uninstall_agents(&self, pkg_id: &str, pkg_slug: &str) -> Result<()>;
}

/// Tiny registry of installed adapters. Lookup is a snapshot-clone — the
/// returned Arcs are independent of the lock so callers can do disk I/O
/// without contending.
#[derive(Default)]
pub struct EngineAdaptersRegistry {
    adapters: RwLock<Vec<Arc<dyn EngineAdapter>>>,
}

impl EngineAdaptersRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an adapter. If one with the same `id()` is already present,
    /// it's replaced — this lets boot replay be idempotent without growing
    /// the vec on every restart.
    pub fn register(&self, adapter: Arc<dyn EngineAdapter>) {
        let id = adapter.id();
        if let Ok(mut g) = self.adapters.write() {
            if let Some(slot) = g.iter_mut().find(|a| a.id() == id) {
                *slot = adapter;
            } else {
                g.push(adapter);
            }
        }
    }

    /// Remove an adapter by id. No-op if not present.
    #[allow(dead_code)]
    #[allow(dead_code)]
    pub fn unregister(&self, id: &str) {
        if let Ok(mut g) = self.adapters.write() {
            g.retain(|a| a.id() != id);
        }
    }

    /// Snapshot the current adapter list under a read lock and return cloned
    /// Arcs. Callers iterate without holding the lock — important because
    /// adapter methods do disk I/O.
    pub fn iter(&self) -> Vec<Arc<dyn EngineAdapter>> {
        self.adapters
            .read()
            .map(|g| g.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Number of registered adapters. Cheap; for snapshot/debug.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.adapters.read().map(|g| g.len()).unwrap_or(0)
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
