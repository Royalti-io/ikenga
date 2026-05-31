//! Engine assets registry — materializes a pkg's `skills` / `commands` /
//! `agents` folders into every installed engine's recognized config tree
//! (see ADR-012 §3 + Track P).
//!
//! Each `(pkg_id, engine_id, kind)` tuple is one logical entry; the
//! in-memory map keys on `pkg_id` and stores a `Vec<AssetEntry>` so the
//! fan-out across N engines lives inside that vec. Today the kernel-resident
//! `EngineAdaptersRegistry` holds exactly one adapter (Claude Code); once
//! the Gemini and Codex Rust adapters land (Tracks G + C) the same fan-out
//! shell handles them with no further plumbing.
//!
//! Behavior parity with the pre-Track-P implementation: one symlink per
//! asset kind under `~/.claude/<kind>/<pkg-slug>/`. The actual symlink call
//! now happens inside the adapter (`install_skills/commands/agents`) so
//! Gemini/Codex can write to their own locations instead.
//!
//! Snapshot shape:
//!   `{ count, entries: [{pkg_id, engine_id, kind, source, target}, ...],
//!      adapter_reports: { <pkg_id>: { <engine_id>: InstallReport } } }`
//!
//! Uninstall removes only the entries this registry created — user content
//! placed under `~/.claude/skills/` directly is never touched.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::pkg::engine_adapter::{EngineAdaptersRegistry, InstallReport};
use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

#[derive(Debug, Clone, Serialize)]
pub struct AssetEntry {
    pub pkg_id: String,
    /// Engine that this entry was materialized for. Per ADR-012 §3 the
    /// semantic identity of an entry is `(pkg_id, engine_id, kind)`; we
    /// preserve that tuple here while keying the outer map on `pkg_id` so
    /// uninstall stays a single `HashMap::remove`.
    pub engine_id: String,
    /// "skills" | "commands" | "agents"
    pub kind: String,
    pub source: String,
    pub target: String,
}

pub struct EngineAssetsRegistry {
    /// `pkg_id` → entries we created (one per engine × kind). Uninstall
    /// walks this list and calls the matching adapter's
    /// `uninstall_<kind>(pkg_id, pkg_slug)`. Empty for pkgs that declare no
    /// asset blocks.
    entries: RwLock<HashMap<String, Vec<AssetEntry>>>,
    /// Per-pkg, per-engine fan-out reports — mirrors `McpRegistry`. Outer
    /// key is `pkg_id`, inner key is `engine_id`. Surfaced via `snapshot()`
    /// for the pkg manager UI's "engine installs" panel.
    adapter_reports: RwLock<HashMap<String, HashMap<String, InstallReport>>>,
    /// Shared handle to the kernel's engine adapter registry. The Default
    /// impl constructs an empty registry so tests that don't care about
    /// adapter fan-out continue to work.
    adapters: Arc<EngineAdaptersRegistry>,
}

impl Default for EngineAssetsRegistry {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            adapter_reports: RwLock::new(HashMap::new()),
            adapters: Arc::new(EngineAdaptersRegistry::new()),
        }
    }
}

impl EngineAssetsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with the kernel-wide adapter registry. The Arc clone is
    /// cheap (refcount); the registry itself is owned by `lib.rs::run`.
    pub fn new_with_adapters(adapters: Arc<EngineAdaptersRegistry>) -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            adapter_reports: RwLock::new(HashMap::new()),
            adapters,
        }
    }

    pub fn list(&self) -> Vec<AssetEntry> {
        self.entries
            .read()
            .map(|g| g.values().flatten().cloned().collect())
            .unwrap_or_default()
    }
}

impl Registry for EngineAssetsRegistry {
    fn name(&self) -> &'static str {
        "engine_assets"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        // WP-17 (ADR-015 decision 4): the asset-bundling MANIFEST FIELDS
        // (`skills`/`commands`/`agents`) are retired — a pkg no longer DECLARES
        // bundled assets. Placement now resolves the pkg's on-disk asset folders
        // BY CONVENTION (`<pkg>/skills`, `/commands`, `/agents`) and fans them out
        // across the per-engine adapters (the kept agnosticism engine). Post-cutover
        // the ONLY pkg still shipping these folders is the shell builtin
        // `com.ikenga.iyke` (its skill + 10 slash-commands) — so this preserves the
        // iyke control-bridge behavior exactly (same `~/.claude/{skills,commands}/
        // com-ikenga-iyke/` symlinks, same `/com-ikenga-iyke:*` namespace) without
        // the manifest coupling. Published pkgs (e.g. studio) ship NO such folder
        // (deleted at cutover) → they place nothing here and instead `requires`
        // standalone Ọba primitives (resolver-driven, WP-16).
        //
        // NOTE: the store models commands as single `.md` files, so the iyke
        // command GROUP can't be a single store primitive without renaming the 10
        // slash-commands — hence the builtin stays folder-placed via the adapters
        // rather than store-seeded (see plans/oba-registry/07-builtin-primitive-cutover.md).
        let pkg_id = pkg.manifest.id.clone();
        let pkg_slug = pkg.slug();

        let mut new_entries: Vec<AssetEntry> = Vec::new();
        let mut per_engine: HashMap<String, InstallReport> = HashMap::new();

        for kind in ["skills", "commands", "agents"] {
            // Convention: the pkg's on-disk `<kind>` folder. Absent ⇒ nothing to place.
            let source = match pkg.resolve_relative(kind) {
                Ok(p) if p.is_dir() => p,
                _ => continue,
            };

            for adapter in self.adapters.iter() {
                let engine_id = adapter.id().to_string();
                let result = match kind {
                    "skills" => adapter.install_skills(source.as_path(), &pkg_id, &pkg_slug),
                    "commands" => adapter.install_commands(source.as_path(), &pkg_id, &pkg_slug),
                    "agents" => adapter.install_agents(source.as_path(), &pkg_id, &pkg_slug),
                    _ => unreachable!("kinds array is exhaustive"),
                };
                let bucket = per_engine.entry(engine_id.clone()).or_default();
                match result {
                    Ok(report) => {
                        for target in &report.wrote {
                            new_entries.push(AssetEntry {
                                pkg_id: pkg_id.clone(),
                                engine_id: engine_id.clone(),
                                kind: kind.to_string(),
                                source: source.display().to_string(),
                                target: target.clone(),
                            });
                        }
                        bucket.merge(report);
                    }
                    Err(e) => {
                        log::warn!(
                            "[pkg.engine_assets] engine `{engine_id}` place `{kind}` for pkg `{pkg_id}` failed: {e:#}"
                        );
                        bucket
                            .warnings
                            .push(format!("engine `{engine_id}` place `{kind}` failed: {e}"));
                    }
                }
            }
        }

        if !new_entries.is_empty() {
            self.entries
                .write()
                .map_err(|_| anyhow!("engine_assets lock poisoned"))?
                .insert(pkg_id.clone(), new_entries);
        }
        if !per_engine.is_empty() {
            self.adapter_reports
                .write()
                .map_err(|_| anyhow!("engine_assets adapter_reports lock poisoned"))?
                .insert(pkg_id, per_engine);
        }
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let to_remove: Vec<AssetEntry> = self
            .entries
            .write()
            .map_err(|_| anyhow!("engine_assets lock poisoned"))?
            .remove(pkg_id)
            .unwrap_or_default();

        // Drop the per-pkg report bucket regardless — even if there were
        // no live entries, prior fan-out reports shouldn't linger.
        if let Ok(mut reports) = self.adapter_reports.write() {
            reports.remove(pkg_id);
        }

        if to_remove.is_empty() {
            return Ok(());
        }

        // Index adapters by id once so the inner loop is O(1).
        let adapters = self.adapters.iter();
        for entry in &to_remove {
            let adapter = adapters.iter().find(|a| a.id() == entry.engine_id);
            let Some(adapter) = adapter else {
                log::warn!(
                    "[pkg.engine_assets] no adapter for engine `{}` during uninstall of pkg `{pkg_id}` ({kind})",
                    entry.engine_id,
                    kind = entry.kind
                );
                continue;
            };
            // Recover the pkg_slug from the target path's last segment.
            // The adapter wrote it there in install; using it back here
            // avoids re-deriving slug from pkg_id (we may not have a
            // Package in scope at uninstall time).
            let slug = std::path::Path::new(&entry.target)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let res = match entry.kind.as_str() {
                "skills" => adapter.uninstall_skills(pkg_id, slug),
                "commands" => adapter.uninstall_commands(pkg_id, slug),
                "agents" => adapter.uninstall_agents(pkg_id, slug),
                other => {
                    log::warn!(
                        "[pkg.engine_assets] unknown asset kind `{other}` for pkg `{pkg_id}`"
                    );
                    continue;
                }
            };
            if let Err(e) = res {
                log::warn!(
                    "[pkg.engine_assets] engine `{}` uninstall `{}` for pkg `{pkg_id}` failed: {e:#}",
                    entry.engine_id,
                    entry.kind
                );
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let entries = self.list();
        let adapter_reports = match self.adapter_reports.read() {
            Ok(g) => serde_json::to_value(&*g).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        json!({
            "count": entries.len(),
            "entries": entries,
            "adapter_reports": adapter_reports,
        })
    }
}
