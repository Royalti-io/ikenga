//! Package kernel.
//!
//! Owns the registry list and drives install / uninstall / boot. Every
//! lifecycle operation runs under a per-package lock (held in a `Mutex<()>`
//! inside the kernel) so install/uninstall can never interleave for the same
//! package id.
//!
//! The kernel is the *only* place that touches `pkg_installed` and the only
//! place that calls `Registry::register/unregister`. Other code that wants to
//! "see what's registered" reads through the kernel's snapshot API.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::db::PaDb;

use super::manifest::{Package, IKENGA_API_MIN_SUPPORTED, IKENGA_API_VERSION};
use super::registry::Registry;
use super::source::InstallSource;

/// Status returned by `pkg_kernel_status` — useful for debugging and the
/// future Settings → Packages page.
#[derive(Debug, Serialize)]
pub struct KernelStatus {
    pub installed: Vec<InstalledSummary>,
    pub registries: HashMap<String, Value>,
    pub api_version: u32,
}

/// One entry returned by `Kernel::discover_workspace` — a manifest dir found
/// in a workspace path. `valid=false` means the dir had a manifest.json but
/// it failed to parse; `error` carries the reason.
#[derive(Debug, Serialize, Clone)]
pub struct DiscoveredPkg {
    pub id: String,
    pub name: String,
    pub version: String,
    pub install_path: String,
    pub valid: bool,
    pub error: Option<String>,
    pub installed: bool,
    pub compatible: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct InstalledSummary {
    pub id: String,
    pub version: String,
    pub ikenga_api: String,
    pub install_path: String,
    pub enabled: bool,
    pub installed_at: i64,
    pub compatible: bool,
    /// Provenance — recorded at install time, used by the UI for grouping
    /// and by the kernel to refuse uninstall of `Builtin` pkgs.
    pub source: InstallSource,
    /// Scope (Phase 2 of projects-first-class). `Some("default" | "music-2026" | …)`
    /// means the pkg loads only when that project is active; `None` is the
    /// workspace scope (always loaded). The Phase 0 bootstrap stamps existing
    /// rows with `Some("default")` so they remain visible after upgrade.
    pub project_id: Option<String>,
}

pub struct Kernel {
    /// Registries are registered once at construction and never mutate after.
    registries: Vec<Arc<dyn Registry>>,

    /// Per-package locks to serialize install/uninstall on the same id.
    /// Stored as a single map behind one outer lock — contention is fine
    /// because lifecycle ops are rare and short.
    pkg_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,

    /// In-memory mirror of `pkg_installed` (read-side cache so listing
    /// doesn't hit SQLite on every call). Writes go to SQLite first.
    installed: RwLock<HashMap<String, InstalledSummary>>,

    /// Tauri app handle, needed to call `add_capability` and (eventually)
    /// resolve `app_data_dir`.
    app: AppHandle,

    /// Shared SQLite handle. The kernel writes to `pkg_installed` /
    /// `pkg_settings` / `pkg_permissions_granted` here; FK cascades on
    /// uninstall clean up children automatically.
    db: Arc<PaDb>,

    /// Phase 2 (projects-first-class): which pkgs are currently
    /// "registered with runtime registries" — i.e. their sidecars are
    /// running, their UI routes are mounted, their MCP/cron/etc.
    /// contributions are live. Distinct from `installed`, which is the
    /// durable set; `live ⊆ installed`. The reconciler diffs `live`
    /// against the target set and registers/unregisters to converge.
    live: RwLock<std::collections::HashSet<String>>,
}

impl Kernel {
    pub fn new(app: AppHandle, db: Arc<PaDb>, registries: Vec<Arc<dyn Registry>>) -> Self {
        Self {
            registries,
            pkg_locks: Mutex::new(HashMap::new()),
            installed: RwLock::new(HashMap::new()),
            app,
            db,
            live: RwLock::new(std::collections::HashSet::new()),
        }
    }

    /// Where unpacked packages live. `~/.local/share/ikenga/pkgs/<id>/`
    /// on Linux; the host-equivalent on mac/win.
    pub fn pkgs_dir(&self) -> Result<PathBuf> {
        let base = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| anyhow!("app_data_dir: {e}"))?;
        Ok(base.join("pkgs"))
    }

    /// Hook for the future install-from-archive path. For now packages are
    /// expected to already exist on disk at `install_path`. The caller must
    /// declare provenance via `source` so the kernel can stamp the
    /// `pkg_installed.source_json` row — this is what later distinguishes
    /// shell-bundled builtins from registry / sideloaded pkgs.
    /// Install a pkg at `install_path` with the given provenance + scope.
    /// `project_id = None` means workspace scope (always loaded);
    /// `Some("default" | other slug)` binds the pkg to that project so it
    /// only loads when the project is active. The kernel persists the
    /// scope on `pkg_installed.project_id` but does *not* perform
    /// reconciliation here — caller is responsible for kicking
    /// `reconcile_for_project` after install if the scope differs from the
    /// active project.
    pub fn install_from_path(
        &self,
        install_path: &Path,
        source: InstallSource,
        project_id: Option<String>,
    ) -> Result<InstalledSummary> {
        let pkg = Package::load(install_path)
            .with_context(|| format!("load manifest at {}", install_path.display()))?;
        let pkg_id = pkg.manifest.id.clone();
        let lock = self.lock_for(&pkg_id);
        // Recover from poison: the `()` payload carries no state, so a prior
        // panic while holding the lock can't have left anything inconsistent.
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

        if !pkg.is_compatible() {
            return Err(anyhow!(
                "package `{pkg_id}` declares ikenga_api={}, host supports [{IKENGA_API_MIN_SUPPORTED}, {IKENGA_API_VERSION}]",
                pkg.manifest.ikenga_api
            ));
        }

        // Reject if already installed at a different path. Re-installing the
        // same path is treated as boot replay (idempotent register, no DB
        // write) — useful for dev-loop where the same dir gets re-poked.
        // Preserve a stronger pre-existing source: if the row is already
        // marked Builtin, never downgrade it to Local on a path-equal replay
        // (e.g. workspace dev pointing at the same dir as a builtin).
        let effective_source = if let Some(existing) = self
            .installed
            .read()
            .ok()
            .and_then(|g| g.get(&pkg_id).cloned())
        {
            if existing.install_path != pkg.install_path.display().to_string() {
                return Err(anyhow!(
                    "package `{pkg_id}` already installed from {} — uninstall first",
                    existing.install_path
                ));
            }
            if existing.source.is_builtin() && !source.is_builtin() {
                existing.source.clone()
            } else {
                source
            }
        } else {
            source
        };

        let installed_at = chrono::Utc::now().timestamp_millis();
        let summary = InstalledSummary {
            id: pkg_id.clone(),
            version: pkg.manifest.version.clone(),
            ikenga_api: pkg.manifest.ikenga_api.clone(),
            install_path: pkg.install_path.display().to_string(),
            enabled: true,
            installed_at,
            compatible: true,
            source: effective_source,
            project_id,
        };

        // Persist the parent `pkg_installed` row BEFORE running registries.
        // Several registries (permissions, settings, migrations) write child
        // rows with `FOREIGN KEY(pkg_id) REFERENCES pkg_installed(id)`, so
        // they need the parent committed first. If the parent write fails,
        // bail before touching any registry.
        let manifest_json =
            serde_json::to_string(&pkg.manifest).map_err(|e| anyhow!("serialize manifest: {e}"))?;
        self.persist_install(&summary, &manifest_json)?;

        // Register against every registry in order. On any failure, walk
        // back over what succeeded, then drop the orphan parent row so the
        // user can retry cleanly.
        let mut applied: Vec<&str> = Vec::new();
        for reg in &self.registries {
            if let Err(e) = reg.register(&pkg) {
                log::error!(
                    "[pkg_kernel] register `{}` failed for `{pkg_id}`: {e}",
                    reg.name()
                );
                self.rollback(&pkg_id, &applied);
                if let Err(de) = self.delete_install_row(&pkg_id) {
                    log::warn!(
                        "[pkg_kernel] post-rollback delete `{pkg_id}` failed (continuing): {de:#}"
                    );
                }
                return Err(e);
            }
            applied.push(reg.name());
        }

        self.installed
            .write()
            .map_err(|_| anyhow!("installed lock poisoned"))?
            .insert(pkg_id.clone(), summary.clone());

        log::info!(
            "[pkg_kernel] installed `{pkg_id}` v{} ({} registries)",
            pkg.manifest.version,
            applied.len()
        );
        Ok(summary)
    }

    fn delete_install_row(&self, pkg_id: &str) -> Result<()> {
        let db = self.db.clone();
        let id_owned = pkg_id.to_string();
        tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query("DELETE FROM pkg_installed WHERE id = ?")
                .bind(&id_owned)
                .execute(&pool)
                .await
                .map_err(|e| anyhow!("delete pkg_installed: {e}"))?;
            Ok::<_, anyhow::Error>(())
        })
    }

    fn persist_install(&self, s: &InstalledSummary, manifest_json: &str) -> Result<()> {
        let db = self.db.clone();
        let source_json = serde_json::to_string(&s.source)
            .map_err(|e| anyhow!("serialize install source: {e}"))?;
        let row = (
            s.id.clone(),
            s.version.clone(),
            s.ikenga_api.clone(),
            manifest_json.to_string(),
            s.install_path.clone(),
            s.installed_at,
            source_json,
            s.project_id.clone(),
        );
        tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query(
                "INSERT OR REPLACE INTO pkg_installed
                 (id, version, ikenga_api, manifest_json, install_path, installed_at, enabled, source_json, project_id)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            )
            .bind(&row.0)
            .bind(&row.1)
            .bind(&row.2)
            .bind(&row.3)
            .bind(&row.4)
            .bind(row.5)
            .bind(&row.6)
            .bind(&row.7)
            .execute(&pool)
            .await
            .map_err(|e| anyhow!("insert pkg_installed: {e}"))?;
            Ok::<_, anyhow::Error>(())
        })
    }

    /// Phase 2: update the scope of an already-installed pkg. `None` means
    /// workspace; `Some(slug)` rebinds it to that project. Returns Err if
    /// the pkg isn't installed. The caller should run a reconcile after
    /// updating to start/stop sidecars affected by the change.
    pub fn set_scope(&self, pkg_id: &str, project_id: Option<String>) -> Result<()> {
        let lock = self.lock_for(pkg_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let exists = self
            .installed
            .read()
            .map(|g| g.contains_key(pkg_id))
            .unwrap_or(false);
        if !exists {
            return Err(anyhow!("pkg not installed: {pkg_id}"));
        }
        let db = self.db.clone();
        let id_owned = pkg_id.to_string();
        let scope_owned = project_id.clone();
        tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query("UPDATE pkg_installed SET project_id = ? WHERE id = ?")
                .bind(&scope_owned)
                .bind(&id_owned)
                .execute(&pool)
                .await
                .map_err(|e| anyhow!("update project_id: {e}"))?;
            Ok::<_, anyhow::Error>(())
        })?;
        if let Ok(mut g) = self.installed.write() {
            if let Some(existing) = g.get_mut(pkg_id) {
                existing.project_id = project_id;
            }
        }
        Ok(())
    }

    /// Whether `pkg_id` is currently visible under `active_project_id`.
    /// Workspace-scoped pkgs (project_id None) are always visible.
    /// Returns false for unknown pkg ids.
    pub fn is_visible_under(&self, pkg_id: &str, active_project_id: &str) -> bool {
        self.installed
            .read()
            .ok()
            .and_then(|g| g.get(pkg_id).map(|s| s.project_id.clone()))
            .map(|scope| match scope {
                None => true,
                Some(p) => p == active_project_id,
            })
            .unwrap_or(false)
    }

    /// Reconcile a pre-existing row's source. Used by `install_builtins()` to
    /// stamp `Builtin` on rows whose ids match the bundled set but were
    /// installed before the source column existed.
    fn reconcile_source(&self, pkg_id: &str, source: &InstallSource) -> Result<()> {
        let db = self.db.clone();
        let id_owned = pkg_id.to_string();
        let source_json =
            serde_json::to_string(source).map_err(|e| anyhow!("serialize install source: {e}"))?;
        tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query("UPDATE pkg_installed SET source_json = ? WHERE id = ?")
                .bind(&source_json)
                .bind(&id_owned)
                .execute(&pool)
                .await
                .map_err(|e| anyhow!("update source_json: {e}"))?;
            Ok::<_, anyhow::Error>(())
        })?;
        if let Ok(mut g) = self.installed.write() {
            if let Some(existing) = g.get_mut(pkg_id) {
                existing.source = source.clone();
            }
        }
        Ok(())
    }

    /// Uninstall: walk registries in reverse, drop the row, mark disabled.
    /// Tauri ACL grants are NOT actually revoked — `add_capability` has no
    /// counterpart. The kernel-side allowlists in each registry stop spawning
    /// the package's binaries / accepting its iyke routes immediately; the
    /// OS-level ACL revocation requires a restart.
    pub fn uninstall(&self, pkg_id: &str) -> Result<()> {
        let lock = self.lock_for(pkg_id);
        // Recover from poison: the `()` payload carries no state, so a prior
        // panic while holding the lock can't have left anything inconsistent.
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Refuse to uninstall shell-bundled builtins. Enforced here (not just
        // in the UI) so CLI / iyke / future remote callers also can't strip
        // them — they'd just get auto-reinstalled on next boot anyway.
        let is_builtin = self
            .installed
            .read()
            .ok()
            .and_then(|g| g.get(pkg_id).map(|s| s.source.is_builtin()))
            .unwrap_or(false);
        if is_builtin {
            return Err(anyhow!(
                "package `{pkg_id}` is shipped with the shell and cannot be uninstalled (disable it instead)"
            ));
        }
        for reg in self.registries.iter().rev() {
            if let Err(e) = reg.unregister(pkg_id) {
                log::warn!(
                    "[pkg_kernel] unregister `{}` failed for `{pkg_id}` (continuing): {e}",
                    reg.name()
                );
            }
        }
        // FK cascades drop pkg_settings / pkg_migrations / pkg_permissions_granted.
        if let Err(e) = self.delete_install_row(pkg_id) {
            log::warn!("[pkg_kernel] DB delete for `{pkg_id}` failed (continuing): {e:#}");
        }
        self.installed
            .write()
            .map_err(|_| anyhow!("installed lock poisoned"))?
            .remove(pkg_id);
        log::info!("[pkg_kernel] uninstalled `{pkg_id}` (restart for full ACL revocation)");
        Ok(())
    }

    /// Live enable/disable. Disable walks registries in reverse so spawning
    /// stops immediately, but keeps the row + manifest_json + child rows
    /// (settings/permissions/migrations) so re-enabling is loss-free.
    pub fn set_enabled(&self, pkg_id: &str, enabled: bool) -> Result<()> {
        let lock = self.lock_for(pkg_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let current = {
            let g = self
                .installed
                .read()
                .map_err(|_| anyhow!("installed lock poisoned"))?;
            g.get(pkg_id).cloned()
        };
        let Some(mut summary) = current else {
            return Err(anyhow!("pkg not installed: {pkg_id}"));
        };
        if summary.enabled == enabled {
            return Ok(());
        }
        if enabled {
            let pkg = Package::load(Path::new(&summary.install_path))
                .with_context(|| format!("load `{pkg_id}` from {}", summary.install_path))?;
            if !pkg.is_compatible() {
                return Err(anyhow!(
                    "pkg `{pkg_id}` ikenga_api={} outside support window",
                    pkg.manifest.ikenga_api
                ));
            }
            let mut applied: Vec<&str> = Vec::new();
            for reg in &self.registries {
                if let Err(e) = reg.register(&pkg) {
                    self.rollback(pkg_id, &applied);
                    return Err(e);
                }
                applied.push(reg.name());
            }
        } else {
            for reg in self.registries.iter().rev() {
                if let Err(e) = reg.unregister(pkg_id) {
                    log::warn!(
                        "[pkg_kernel] unregister `{}` failed for `{pkg_id}` (continuing): {e}",
                        reg.name()
                    );
                }
            }
        }
        self.update_enabled_row(pkg_id, enabled)?;
        summary.enabled = enabled;
        self.installed
            .write()
            .map_err(|_| anyhow!("installed lock poisoned"))?
            .insert(pkg_id.to_string(), summary);
        log::info!(
            "[pkg_kernel] {} `{pkg_id}`",
            if enabled { "enabled" } else { "disabled" }
        );
        Ok(())
    }

    fn update_enabled_row(&self, pkg_id: &str, enabled: bool) -> Result<()> {
        let db = self.db.clone();
        let id_owned = pkg_id.to_string();
        let val: i64 = if enabled { 1 } else { 0 };
        tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query("UPDATE pkg_installed SET enabled = ? WHERE id = ?")
                .bind(val)
                .bind(&id_owned)
                .execute(&pool)
                .await
                .map_err(|e| anyhow!("update enabled: {e}"))?;
            Ok::<_, anyhow::Error>(())
        })
    }

    /// Discover (but do NOT install) packages under a workspace directory.
    /// Used in dev mode to surface sibling pkgs from a monorepo-style
    /// workspace (e.g. `royalti-co/ikenga/pkgs/*`) in the Pkg Manager UI so
    /// the user can opt-in to installing them with `pkg_install_from_path`.
    ///
    /// Read-only: never mutates `pkg_installed` or any registry. Returns one
    /// entry per direct child directory that contains a parseable
    /// `manifest.json`; entries that fail to parse are reported as
    /// `valid=false` with the error so the FE can show a useful warning
    /// rather than silently dropping them.
    pub fn discover_workspace(&self, workspace_dir: &Path) -> Vec<DiscoveredPkg> {
        let mut out = Vec::new();
        if !workspace_dir.is_dir() {
            return out;
        }
        let entries = match std::fs::read_dir(workspace_dir) {
            Ok(e) => e,
            Err(err) => {
                log::warn!(
                    "[pkg_kernel] discover_workspace: read_dir({}) failed: {err}",
                    workspace_dir.display()
                );
                return out;
            }
        };
        let installed_ids: std::collections::HashSet<String> = self
            .installed
            .read()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            match super::manifest::Package::load(&path) {
                Ok(pkg) => out.push(DiscoveredPkg {
                    id: pkg.manifest.id.clone(),
                    name: pkg.manifest.name.clone(),
                    version: pkg.manifest.version.clone(),
                    install_path: path.display().to_string(),
                    valid: true,
                    error: None,
                    installed: installed_ids.contains(&pkg.manifest.id),
                    compatible: pkg.is_compatible(),
                }),
                Err(e) => out.push(DiscoveredPkg {
                    id: String::new(),
                    name: String::new(),
                    version: String::new(),
                    install_path: path.display().to_string(),
                    valid: false,
                    error: Some(format!("{e:#}")),
                    installed: false,
                    compatible: false,
                }),
            }
        }
        out
    }

    /// Auto-install built-in packages bundled with the app on first boot.
    ///
    /// The desktop app ships a small set of "meta-packages" (today: just
    /// `com.ikenga.iyke`) under `<resource_dir>/builtin-pkgs/`. Each one is
    /// installed exactly like a user package — same manifest contract, same
    /// kernel lifecycle — but the kernel is responsible for ensuring at least
    /// the iyke skill is present on a fresh machine so any Claude session
    /// (in-app or terminal) can drive the desktop UI from day one.
    ///
    /// Idempotent: skips any built-in already in `pkg_installed`. Failures
    /// log a warning and continue — they're not fatal because the rest of
    /// the kernel works without these packages.
    pub fn install_builtins(&self, resource_dir: &Path) -> Result<()> {
        let builtins_dir = resource_dir.join("builtin-pkgs");
        if !builtins_dir.is_dir() {
            log::info!(
                "[pkg_kernel] no builtin-pkgs/ at {} — skipping auto-install",
                builtins_dir.display()
            );
            return Ok(());
        }
        let entries = std::fs::read_dir(&builtins_dir)
            .with_context(|| format!("read {}", builtins_dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            // Cheap pre-read of the id so we can skip already-installed
            // built-ins without going through the full Package::load path.
            let id_opt = std::fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("id").and_then(|s| s.as_str().map(String::from)));
            let id = match id_opt {
                Some(id) => id,
                None => {
                    log::warn!(
                        "[pkg_kernel] builtin at {} has no id — skipping",
                        path.display()
                    );
                    continue;
                }
            };
            let already_installed = self
                .installed
                .read()
                .map(|g| g.contains_key(&id))
                .unwrap_or(false);
            if already_installed {
                // Backfill: if the row predates the source column or was
                // (somehow) installed as Local, restamp it as Builtin so
                // the uninstall guard and UI grouping behave correctly.
                let needs_restamp = self
                    .installed
                    .read()
                    .ok()
                    .and_then(|g| g.get(&id).map(|s| !s.source.is_builtin()))
                    .unwrap_or(false);
                if needs_restamp {
                    if let Err(e) = self.reconcile_source(&id, &InstallSource::Builtin) {
                        log::warn!(
                            "[pkg_kernel] could not stamp `{id}` as Builtin (continuing): {e:#}"
                        );
                    } else {
                        log::info!("[pkg_kernel] reconciled `{id}` source → builtin");
                    }
                } else {
                    log::debug!("[pkg_kernel] builtin `{id}` already installed — skipping");
                }
                continue;
            }
            // Builtins are always workspace-scoped — they're shell-shipped
            // and ought to load regardless of which project is active.
            match self.install_from_path(&path, InstallSource::Builtin, None) {
                Ok(s) => log::info!(
                    "[pkg_kernel] auto-installed builtin `{}` v{}",
                    s.id,
                    s.version
                ),
                Err(e) => log::warn!(
                    "[pkg_kernel] auto-install builtin at {} failed (continuing): {e:#}",
                    path.display()
                ),
            }
        }
        Ok(())
    }

    /// Discover pkgs that exist on disk under `pkgs_dir()` but aren't yet
    /// tracked in `pkg_installed`. Used to pick up CLI-installed pkgs the
    /// user dropped in while the shell was offline — same pattern as
    /// `install_builtins`, but scans the runtime data dir and records the
    /// source as `Local` (the CLI doesn't currently write provenance to
    /// disk; a future `.source.json` sidecar would let this stamp
    /// `Registry { url }` instead).
    ///
    /// Idempotent — re-running on an already-tracked install path is a no-op.
    /// Failures on individual entries log and continue.
    pub fn install_from_pkgs_dir(&self) -> Result<()> {
        let dir = self.pkgs_dir()?;
        if !dir.is_dir() {
            return Ok(());
        }
        let entries = std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Skip the installer's own staging/backup directories.
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
                    continue;
                }
            }
            let manifest_path = path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            // Cheap pre-read of the id; skip if already-installed (the
            // path-equal replay inside install_from_path is also idempotent,
            // but checking here avoids re-reading the full manifest).
            let id_opt = std::fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("id").and_then(|s| s.as_str().map(String::from)));
            let id = match id_opt {
                Some(id) => id,
                None => {
                    log::warn!(
                        "[pkg_kernel] pkgs-dir entry at {} has no id — skipping",
                        path.display()
                    );
                    continue;
                }
            };
            let already_installed = self
                .installed
                .read()
                .map(|g| g.contains_key(&id))
                .unwrap_or(false);
            if already_installed {
                log::debug!("[pkg_kernel] pkgs-dir entry `{id}` already tracked — skipping");
                continue;
            }
            let path_str = path.display().to_string();
            // CLI sideloads default to workspace scope — the shell may not
            // know which project the user intended. They can move it via
            // Settings → Packages or `iyke_pkg_install_scope_set`.
            match self.install_from_path(&path, InstallSource::Local { path: path_str }, None) {
                Ok(s) => log::info!(
                    "[pkg_kernel] discovered pkgs-dir pkg `{}` v{} (CLI install)",
                    s.id,
                    s.version
                ),
                Err(e) => log::warn!(
                    "[pkg_kernel] register pkgs-dir entry at {} failed (continuing): {e:#}",
                    path.display()
                ),
            }
        }
        Ok(())
    }

    /// Boot-time replay: read every enabled `pkg_installed` row, reconstruct
    /// the Package from disk, and replay register against every registry. A
    /// package whose `install_path` is missing or whose manifest no longer
    /// loads gets logged and skipped — the row stays so the user can decide
    /// to repair or uninstall via the UI.
    pub fn boot(&self) -> Result<()> {
        let db = self.db.clone();
        let (rows, total_rows): (
            Vec<(String, String, i64, Option<String>, Option<String>)>,
            i64,
        ) = tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            // Diagnostic: total row count regardless of `enabled`. Distinguishes
            // "wrong DB file" / "missing rows" from "all rows disabled".
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pkg_installed")
                .fetch_one(&pool)
                .await
                .map_err(|e| anyhow!("count pkg_installed: {e}"))?;
            let r: Vec<(String, String, i64, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT id, install_path, installed_at, source_json, project_id
                 FROM pkg_installed WHERE enabled = 1",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| anyhow!("read pkg_installed: {e}"))?;
            Ok::<_, anyhow::Error>((r, total))
        })?;
        log::info!(
            "[pkg_kernel] boot: pkg_installed total_rows={total_rows} enabled_rows={}",
            rows.len()
        );

        let mut replayed = 0usize;
        let mut skipped = 0usize;
        for (id, install_path, installed_at, source_raw, project_id) in rows {
            match Package::load(Path::new(&install_path)) {
                Ok(pkg) => {
                    if !pkg.is_compatible() {
                        log::warn!(
                            "[pkg_kernel] boot: `{id}` ikenga_api={} outside support window — skipping",
                            pkg.manifest.ikenga_api
                        );
                        skipped += 1;
                        continue;
                    }
                    let mut applied: Vec<&str> = Vec::new();
                    let mut failed = false;
                    for reg in &self.registries {
                        if let Err(e) = reg.register(&pkg) {
                            log::error!(
                                "[pkg_kernel] boot: register `{}` failed for `{id}`: {e}",
                                reg.name()
                            );
                            self.rollback(&id, &applied);
                            failed = true;
                            break;
                        }
                        applied.push(reg.name());
                    }
                    if failed {
                        skipped += 1;
                        continue;
                    }
                    let source =
                        InstallSource::parse_or_local(source_raw.as_deref(), &install_path);
                    let summary = InstalledSummary {
                        id: id.clone(),
                        version: pkg.manifest.version.clone(),
                        ikenga_api: pkg.manifest.ikenga_api.clone(),
                        install_path,
                        enabled: true,
                        installed_at,
                        compatible: true,
                        source,
                        project_id,
                    };
                    if let Ok(mut g) = self.installed.write() {
                        g.insert(id.clone(), summary);
                    }
                    replayed += 1;
                }
                Err(e) => {
                    log::warn!(
                        "[pkg_kernel] boot: load `{id}` from `{install_path}` failed (skipping): {e:#}"
                    );
                    skipped += 1;
                }
            }
        }
        log::info!(
            "[pkg_kernel] boot — {} registries, replayed {replayed}, skipped {skipped}",
            self.registries.len()
        );
        Ok(())
    }

    /// Look up an installed package by id and return its on-disk install
    /// path. Used by `pkg_mcp_call` to resolve relative paths in the
    /// manifest's mcp server `args` (working dir for the spawned child).
    pub fn installed_path(&self, pkg_id: &str) -> Option<PathBuf> {
        self.installed
            .read()
            .ok()
            .and_then(|g| g.get(pkg_id).map(|s| PathBuf::from(&s.install_path)))
    }

    /// Snapshot of the installed map. Useful for the reconciler and other
    /// callers that want full info, not just the kernel status payload.
    pub fn list_installed(&self) -> Vec<InstalledSummary> {
        self.installed
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Look up a single installed summary by id without cloning the whole
    /// map. Phase 5 of projects-first-class uses this to find an MCP child's
    /// own project scope (workspace or `project:<id>`) before spawning, so
    /// it can inject the matching `IKENGA_PROJECT_ID` env.
    pub fn installed_summary(&self, pkg_id: &str) -> Option<InstalledSummary> {
        self.installed
            .read()
            .ok()
            .and_then(|g| g.get(pkg_id).cloned())
    }

    /// Phase 2 reconciler. For each installed pkg, ensure its registry
    /// contribution + sidecar match its scope vs the active project:
    /// - workspace (project_id None) → always live.
    /// - project_id Some(p) where p == active → live.
    /// - otherwise → parked (unregistered from runtime registries).
    ///
    /// "Live" pkgs missing from runtime registries get registered.
    /// "Parked" pkgs present in runtime registries get unregistered.
    /// Idempotent: re-running with the same active is a no-op.
    ///
    /// We track which pkgs are currently "live" in `live` and compare on
    /// each reconcile to compute the delta.
    pub fn reconcile_for_project(&self, active_project_id: &str) -> Result<()> {
        let installed = self.list_installed();
        let want_live: std::collections::HashSet<String> = installed
            .iter()
            .filter(|s| match &s.project_id {
                None => true,
                Some(p) => p == active_project_id,
            })
            .map(|s| s.id.clone())
            .collect();

        let mut live_guard = self
            .live
            .write()
            .map_err(|_| anyhow!("live lock poisoned"))?;
        let prev_live: std::collections::HashSet<String> = live_guard.clone();

        // Park anything live → not in target set.
        for pkg_id in prev_live
            .difference(&want_live)
            .cloned()
            .collect::<Vec<_>>()
        {
            log::info!("[pkg_kernel] reconcile: parking `{pkg_id}` (scope mismatch)");
            for reg in self.registries.iter().rev() {
                if let Err(e) = reg.unregister(&pkg_id) {
                    log::warn!(
                        "[pkg_kernel] reconcile: unregister `{}` for `{pkg_id}` failed: {e}",
                        reg.name()
                    );
                }
            }
            live_guard.remove(&pkg_id);
        }

        // Resume anything in target set → not yet live.
        for pkg_id in want_live
            .difference(&prev_live)
            .cloned()
            .collect::<Vec<_>>()
        {
            let install_path = installed
                .iter()
                .find(|s| s.id == pkg_id)
                .map(|s| s.install_path.clone());
            let Some(install_path) = install_path else {
                continue;
            };
            match Package::load(Path::new(&install_path)) {
                Ok(pkg) => {
                    log::info!("[pkg_kernel] reconcile: resuming `{pkg_id}`");
                    let mut applied: Vec<&str> = Vec::new();
                    let mut failed = false;
                    for reg in &self.registries {
                        if let Err(e) = reg.register(&pkg) {
                            log::warn!(
                                "[pkg_kernel] reconcile: register `{}` for `{pkg_id}` failed: {e}",
                                reg.name()
                            );
                            // Roll back what we managed to apply for this pkg.
                            for name in applied.iter().rev() {
                                if let Some(r) = self.registries.iter().find(|r| r.name() == *name)
                                {
                                    let _ = r.unregister(&pkg_id);
                                }
                            }
                            failed = true;
                            break;
                        }
                        applied.push(reg.name());
                    }
                    if !failed {
                        live_guard.insert(pkg_id);
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[pkg_kernel] reconcile: load `{pkg_id}` at {install_path} failed: {e:#}"
                    );
                }
            }
        }
        Ok(())
    }

    /// Mark every installed pkg as live. Used by `boot()` (which has
    /// already registered everything) so the reconciler knows the
    /// current truth at startup. Called from lib.rs setup after
    /// `kernel.boot()` returns.
    pub fn mark_all_live(&self) {
        if let Ok(g) = self.installed.read() {
            if let Ok(mut live) = self.live.write() {
                live.clear();
                for id in g.keys() {
                    live.insert(id.clone());
                }
            }
        }
    }

    pub fn status(&self) -> KernelStatus {
        let installed = self
            .installed
            .read()
            .map(|g| g.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let registries = self
            .registries
            .iter()
            .map(|r| (r.name().to_string(), r.snapshot()))
            .collect();
        KernelStatus {
            installed,
            registries,
            api_version: IKENGA_API_VERSION,
        }
    }

    fn rollback(&self, pkg_id: &str, applied: &[&str]) {
        for name in applied.iter().rev() {
            if let Some(reg) = self.registries.iter().find(|r| r.name() == *name) {
                if let Err(e) = reg.unregister(pkg_id) {
                    log::warn!("[pkg_kernel] rollback `{name}` for `{pkg_id}` failed: {e}");
                }
            }
        }
    }

    /// Returns the Arc for this package's lifecycle lock. Caller is
    /// expected to immediately `.lock()` it and hold the guard for the
    /// duration of the lifecycle op. Returning the Arc (not the guard)
    /// avoids lifetime gymnastics — the Arc owns the Mutex.
    fn lock_for(&self, pkg_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.pkg_locks.lock().expect("pkg_locks poisoned");
        map.entry(pkg_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

// Use `tauri::Manager` for `app.path()`.
use tauri::Manager;
