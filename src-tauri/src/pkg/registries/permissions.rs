//! Permissions registry — translates manifest `permissions.*` blocks into
//! Tauri runtime capabilities via `Manager::add_capability`.
//!
//! Scope today: `fs.read`, `fs.write`, `shell.execute`. Net / supabase /
//! vault scopes are declared in the manifest but not yet wired (they'll need
//! their own enforcement points beyond Tauri ACL — net via a request
//! interceptor, supabase via RLS, vault via the existing key-prefix check).
//!
//! Placeholder resolution at register time:
//!   - `$pkg_install/...` → the package's install dir
//!   - `$pkg_data/...`    → `<app_data_dir>/pkgs/<id>/data`
//!   - `$home/...`        → `$HOME/...`
//! All resolved paths are joined under the package's sandbox if relative;
//! absolute paths must already be under one of the placeholders or be
//! explicitly user-approved (currently all explicit absolute paths are
//! accepted in personal-use mode — permission-prompting lands later).
//!
//! Important plugin-fs gotcha (proven by the spike): `read_text_file`
//! requires `fs:allow-read-text-file`, NOT `fs:allow-read-file`. The lookup
//! table in `fs_read_permissions` mirrors what plugin-fs actually checks
//! per command — we grant *both* the text and binary variants for an
//! `fs.read` entry so package authors don't have to think about which
//! flavour they'll use.
//!
//! Capability lifecycle: Tauri 2.11 has no `remove_capability`. On uninstall
//! we mark the package's grants dropped in `pkg_permissions_granted` and
//! remove them from the registry's in-memory tracker, but the Tauri-level
//! ACL grant survives until process exit. The kernel surfaces this in the
//! uninstall log; the package can no longer be spawned via the kernel's
//! sidecar registry, so the still-granted scope is unreachable in practice.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager};

#[derive(Serialize, Clone)]
struct FsScopeEntry {
    path: String,
}

use crate::commands::db::PaDb;
use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

/// One granted-scope row, mirrors `pkg_permissions_granted` schema for the
/// in-memory snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct GrantedScope {
    pub pkg_id: String,
    pub scope_kind: String,  // "fs.read" | "fs.write" | "shell.execute"
    pub scope_value: String, // resolved path or binary name
    pub capability_id: String,
}

pub struct PermissionsRegistry {
    app: AppHandle,
    db: Arc<PaDb>,
    /// Granted scopes per package. Used for snapshot + uninstall (in-memory
    /// only — persistent state lives in `pkg_permissions_granted`).
    granted: RwLock<HashMap<String, Vec<GrantedScope>>>,
}

impl PermissionsRegistry {
    pub fn new(app: AppHandle, db: Arc<PaDb>) -> Self {
        Self {
            app,
            db,
            granted: RwLock::new(HashMap::new()),
        }
    }

    /// Resolve placeholder-bearing paths to absolute paths for this package.
    /// Returns Err on unrecognised placeholders so silent typos don't grant
    /// nothing-and-look-fine.
    fn resolve_path(&self, pkg: &Package, raw: &str) -> Result<PathBuf> {
        let home = crate::platform::home_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let app_data = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| anyhow!("app_data_dir: {e}"))?;
        let pkg_data = app_data.join("pkgs").join(&pkg.manifest.id).join("data");
        let install = pkg.install_path.display().to_string();

        let expanded = raw
            .replace("$pkg_install", &install)
            .replace("$pkg_data", &pkg_data.display().to_string())
            .replace("$home", &home);

        if expanded.contains('$') {
            return Err(anyhow!(
                "unresolved placeholder in `{raw}` (got `{expanded}`)"
            ));
        }
        Ok(PathBuf::from(expanded))
    }

    /// One capability per (kind, perm, path-index) tuple so each
    /// `add_capability` call carries exactly one `permission_scoped`. The
    /// 2026-05-04 EntryRaw regression reproduced when multiple
    /// `permission_scoped` calls were chained on one builder; the dev-mode
    /// spike (one perm per cap) is known-good. Mirror that.
    ///
    /// No dots: Tauri capability identifiers tolerate hyphens but multi-dot
    /// ids appeared to corrupt scope deserialization in 2.11. Spike used a
    /// single-dot id and worked; mimicking that shape.
    fn cap_id_perm(&self, pkg: &Package, kind: &str, perm: &str, idx: usize) -> String {
        // Drop the plugin prefix and `allow-` from the perm to keep ids short:
        // `fs:allow-read-text-file` → `read-text-file`. Tauri identifiers don't
        // permit `:`; keep this defensive even though `perm.replace(':', "-")`
        // would also work.
        let perm_short = perm
            .split_once(':')
            .map(|(_, rest)| rest)
            .unwrap_or(perm)
            .trim_start_matches("allow-");
        format!(
            "pkg-{}-{}-{}-{idx}",
            pkg.slug(),
            kind.replace('.', "-"),
            perm_short
        )
    }

    /// Persist a grant row. Errors are logged but not fatal — the in-memory
    /// + Tauri-level grant has already been applied; the audit row is
    /// best-effort.
    fn persist(&self, scope: &GrantedScope) {
        let db = self.db.clone();
        let s = scope.clone();
        let now = chrono::Utc::now().timestamp_millis();
        let res: Result<(), anyhow::Error> = tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query(
                "INSERT OR REPLACE INTO pkg_permissions_granted
                 (pkg_id, scope_kind, scope_value, granted_at)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&s.pkg_id)
            .bind(&s.scope_kind)
            .bind(&s.scope_value)
            .bind(now)
            .execute(&pool)
            .await
            .map_err(|e| anyhow!("insert pkg_permissions_granted: {e}"))?;
            Ok(())
        });
        if let Err(e) = res {
            log::warn!(
                "[pkg.permissions] persist `{}/{}/{}` failed: {e:#}",
                scope.pkg_id,
                scope.scope_kind,
                scope.scope_value
            );
        }
    }

    fn delete_grants(&self, pkg_id: &str) {
        let db = self.db.clone();
        let id = pkg_id.to_string();
        let res: Result<(), anyhow::Error> = tauri::async_runtime::block_on(async move {
            let pool = db.ensure_pool().await.map_err(|e| anyhow!(e))?;
            sqlx::query("DELETE FROM pkg_permissions_granted WHERE pkg_id = ?")
                .bind(&id)
                .execute(&pool)
                .await
                .map_err(|e| anyhow!("delete grants: {e}"))?;
            Ok(())
        });
        if let Err(e) = res {
            log::warn!("[pkg.permissions] delete grants for `{pkg_id}` failed: {e:#}");
        }
    }

    fn add_fs_read(&self, pkg: &Package, idx: usize, raw: &str) -> Result<GrantedScope> {
        let path = self.resolve_path(pkg, raw)?;
        let path_str = path.display().to_string();
        // 2026-05-15 (runtime ACL phase): emit ONE capability per permission
        // rather than chaining multiple `permission_scoped` calls onto one
        // builder. The chained shape reproduced an EntryRaw deserialization
        // regression that propagated across all in-process fs reads (see
        // 2026-05-04 note in `fs_read_permissions`). The dev-mode spike
        // (`commands/spike.rs`) grants one perm per cap and works cleanly;
        // mirror that exactly.
        let cap_ids =
            self.add_fs_capabilities(pkg, "fs.read", idx, &path_str, fs_read_permissions())?;
        Ok(GrantedScope {
            pkg_id: pkg.manifest.id.clone(),
            scope_kind: "fs.read".into(),
            scope_value: path_str,
            capability_id: cap_ids,
        })
    }

    fn add_fs_write(&self, pkg: &Package, idx: usize, raw: &str) -> Result<GrantedScope> {
        let path = self.resolve_path(pkg, raw)?;
        let path_str = path.display().to_string();
        let cap_ids =
            self.add_fs_capabilities(pkg, "fs.write", idx, &path_str, fs_write_permissions())?;
        Ok(GrantedScope {
            pkg_id: pkg.manifest.id.clone(),
            scope_kind: "fs.write".into(),
            scope_value: path_str,
            capability_id: cap_ids,
        })
    }

    /// Add one capability per permission, all scoped to the same path. Returns
    /// a comma-joined list of the resulting capability identifiers (recorded
    /// in `GrantedScope.capability_id` for audit). Bails on the first failed
    /// `add_capability`; preceding caps remain in the runtime authority
    /// (Tauri 2.11 has no remove counterpart, same caveat as the file
    /// header). Caller is expected to have validated all paths first via
    /// `resolve_path` so the only realistic failure here is a Tauri-internal
    /// resolve error.
    fn add_fs_capabilities(
        &self,
        pkg: &Package,
        kind: &str,
        idx: usize,
        path_str: &str,
        perms: &[&str],
    ) -> Result<String> {
        let mut cap_ids: Vec<String> = Vec::with_capacity(perms.len());
        for perm in perms {
            let cap_id = self.cap_id_perm(pkg, kind, perm, idx);
            let builder = CapabilityBuilder::new(&cap_id)
                // Grant targets the PRIMARY window only. Detached windows use
                // the minimal `window-detached.json` capability and don't drive
                // pkg FS reads in Phase 1; extending this to a `detached-*` glob
                // would broaden the surface WP-03 deliberately minimized.
                // TODO(multi-window): grant per-window when a detached surface
                // needs dynamic FS.
                .window("main")
                .permission_scoped(
                    *perm,
                    vec![FsScopeEntry {
                        path: path_str.to_string(),
                    }],
                    Vec::<FsScopeEntry>::new(),
                );
            self.app
                .add_capability(builder)
                .map_err(|e| anyhow!("add `{perm}` capability `{cap_id}`: {e}"))?;
            cap_ids.push(cap_id);
        }
        Ok(cap_ids.join(","))
    }

    // shell.execute enforcement is intentionally not done via Tauri ACL.
    // Kernel-driven sidecar spawns (`pkg::lifecycle::SidecarSupervisor::spawn`,
    // `pkg::mcp_runtime::call_tool`) bypass `tauri-plugin-shell` and use
    // `tokio::process::Command` directly, so a `shell:allow-spawn` grant
    // wouldn't gate them. Enforcement lives in `pkg::permissions_check`
    // (Phase 2 of `2026-05-15-runtime-acl-enforcement`); the manifest's
    // declared `shell.execute` allowlist is the source of truth there.
}

impl Registry for PermissionsRegistry {
    fn name(&self) -> &'static str {
        "permissions"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        let perms = &pkg.manifest.permissions;
        if perms.fs_read.is_empty() && perms.fs_write.is_empty() && perms.shell_execute.is_empty() {
            return Ok(());
        }

        // Build all grants first so a single bad scope aborts cleanly. add_capability
        // is append-only with no remove counterpart, so once we've called it we
        // can't undo — validate before granting.
        let mut grants: Vec<GrantedScope> = Vec::new();
        for (i, raw) in perms.fs_read.iter().enumerate() {
            grants
                .push(self.add_fs_read(pkg, i, raw).with_context(|| {
                    format!("pkg `{}` fs.read[{i}] = `{raw}`", pkg.manifest.id)
                })?);
        }
        for (i, raw) in perms.fs_write.iter().enumerate() {
            grants.push(
                self.add_fs_write(pkg, i, raw).with_context(|| {
                    format!("pkg `{}` fs.write[{i}] = `{raw}`", pkg.manifest.id)
                })?,
            );
        }
        // shell.execute is enforced at kernel spawn sites
        // (`pkg::permissions_check`), not via Tauri ACL — see header comment
        // on `add_shell_execute`'s removal site for why. The allowlist is
        // read directly from `pkg.manifest.permissions.shell_execute` at
        // spawn time, so nothing to do here at register time.

        // Persist + record in-memory.
        for g in &grants {
            self.persist(g);
        }
        let mut map = self
            .granted
            .write()
            .map_err(|_| anyhow!("permissions lock poisoned"))?;
        map.insert(pkg.manifest.id.clone(), grants);
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        // In-memory + DB only — Tauri-level capabilities survive until restart.
        self.delete_grants(pkg_id);
        if let Ok(mut map) = self.granted.write() {
            map.remove(pkg_id);
        }
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let map = match self.granted.read() {
            Ok(g) => g,
            Err(_) => return json!({ "error": "lock poisoned" }),
        };
        let entries: Vec<Value> = map
            .values()
            .flat_map(|v| {
                v.iter()
                    .map(|g| serde_json::to_value(g).unwrap_or(json!(null)))
            })
            .collect();
        json!({
            "count": entries.len(),
            "entries": entries,
            "note": "tauri capabilities survive until process restart even after unregister",
        })
    }
}

/// plugin-fs permissions a package needs for "I want to read this path."
/// Listing every variant is intentional — without `fs:allow-read-text-file`
/// JS-side `readTextFile` fails with the long-permission-list error, even
/// though `fs:allow-read-file` is granted. Spike caught this on day one.
///
/// 2026-05-15: both variants restored after the runtime-ACL phase split
/// each entry into one-capability-per-permission (see `add_fs_capabilities`).
/// The 2026-05-04 EntryRaw regression was triggered by chaining multiple
/// `permission_scoped` calls on a single builder, not by listing both
/// permissions per se.
fn fs_read_permissions() -> &'static [&'static str] {
    &["fs:allow-read-text-file", "fs:allow-read-file"]
}

fn fs_write_permissions() -> &'static [&'static str] {
    &["fs:allow-write-text-file", "fs:allow-write-file"]
}
