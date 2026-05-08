//! Tauri commands for the package kernel. The frontend uses these to install,
//! list, uninstall, and inspect packages; the same surface is exposed to
//! external tools via the iyke bridge once the iyke routes registry lands.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::pkg::registries::SettingsRegistry;
use crate::pkg::{DiscoveredPkg, InstallSource, InstalledSummary, Kernel, KernelStatus};

/// State wrapper so the kernel can be stored in Tauri state behind an Arc.
pub struct KernelState(pub Arc<Kernel>);

/// Standalone handle on the settings registry so `pkg_settings_*` commands
/// can read declared schemas without going through the kernel snapshot.
pub struct PkgSettingsState(pub Arc<SettingsRegistry>);

#[derive(Serialize)]
pub struct PkgInstallResult {
    pub installed: InstalledSummary,
}

#[tauri::command]
pub fn pkg_install_from_path(
    kernel: State<'_, KernelState>,
    install_path: String,
) -> Result<PkgInstallResult, String> {
    let path = PathBuf::from(&install_path);
    // FE / iyke / dev-mode workspace installs are all `Local` provenance.
    // Registry installs go through a separate command once the registry
    // client lands; builtins go through `install_builtins()` at boot.
    let source = InstallSource::Local {
        path: install_path,
    };
    let installed = kernel
        .0
        .install_from_path(&path, source)
        .map_err(|e| format!("{e:#}"))?;
    Ok(PkgInstallResult { installed })
}

#[tauri::command]
pub fn pkg_uninstall(kernel: State<'_, KernelState>, pkg_id: String) -> Result<(), String> {
    kernel.0.uninstall(&pkg_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pkg_set_enabled(
    kernel: State<'_, KernelState>,
    pkg_id: String,
    enabled: bool,
) -> Result<(), String> {
    kernel
        .0
        .set_enabled(&pkg_id, enabled)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pkg_kernel_status(kernel: State<'_, KernelState>) -> KernelStatus {
    kernel.0.status()
}

/// Dev-mode helper: scan a workspace directory (e.g.
/// `~/royalti-co/ikenga/pkgs`) for sibling pkgs and return manifest metadata
/// without installing anything. The FE surfaces this in the Pkg Manager so
/// the user can install workspace pkgs with one click during local dev.
///
/// If `workspace_dir` is `None`, falls back to the `IKENGA_WORKSPACE_DIR`
/// env var. Returns an empty list when neither is set or the path is missing
/// — never fails.
#[tauri::command]
pub fn pkg_discover_workspace(
    kernel: State<'_, KernelState>,
    workspace_dir: Option<String>,
) -> Vec<DiscoveredPkg> {
    let path = workspace_dir
        .or_else(|| std::env::var("IKENGA_WORKSPACE_DIR").ok())
        .map(PathBuf::from);
    match path {
        Some(p) => kernel.0.discover_workspace(&p),
        None => Vec::new(),
    }
}

/// Read a manifest at the given install path WITHOUT registering it. Used
/// by the Install panel to preview what a package declares before the user
/// commits to running the install prompt with Claude. Returns the parsed
/// manifest as JSON so the FE can render permissions, settings schema, and
/// any other declared blocks generically.
#[tauri::command]
pub fn pkg_preview_manifest(install_path: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(install_path);
    let pkg = crate::pkg::manifest::Package::load(&path)
        .map_err(|e| format!("{e:#}"))?;
    serde_json::to_value(&pkg.manifest).map_err(|e| format!("serialize manifest: {e}"))
}

/// Diagnostic: returns `(db_path, pkg_installed_count)` straight from the
/// kernel's PaDb handle. Used to confirm the kernel is reading the same
/// SQLite file as external tooling expects.
#[derive(serde::Serialize)]
pub struct PkgDbDiag {
    pub db_path: String,
    pub pkg_installed_count: i64,
    pub ids: Vec<String>,
}

#[tauri::command]
pub fn pkg_db_diag(
    db: tauri::State<'_, std::sync::Arc<crate::commands::db::PaDb>>,
) -> Result<PkgDbDiag, String> {
    let db_path = db.db_path_for_diag().display().to_string();
    let db_clone = db.inner().clone();
    let (count, ids): (i64, Vec<String>) = tauri::async_runtime::block_on(async move {
        let pool = db_clone.ensure_pool().await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pkg_installed")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM pkg_installed ORDER BY id")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;
        Ok::<_, String>((count, ids))
    })?;
    Ok(PkgDbDiag { db_path, pkg_installed_count: count, ids })
}

// ─── pkg_settings ────────────────────────────────────────────────────────────
//
// Per-package key/value settings backed by the `pkg_settings` table. Schema
// (used for default-fallback and the future Settings UI) is declared in the
// manifest under `settings.schema`. Get falls back to the schema default if
// no row exists yet — handy for first-launch reads before defaults have
// been seeded by `register()` (rare, but cheap insurance).

#[derive(serde::Serialize)]
pub struct PkgSettingsSnapshot {
    pub pkg_id: String,
    pub schema: serde_json::Value,
    pub values: serde_json::Value,
}

#[tauri::command]
pub fn pkg_settings_get(
    settings: State<'_, PkgSettingsState>,
    db: State<'_, Arc<crate::commands::db::PaDb>>,
    pkg_id: String,
) -> Result<PkgSettingsSnapshot, String> {
    let schema = settings.0.schema_for(&pkg_id);
    let db_clone = db.inner().clone();
    let pkg_for_query = pkg_id.clone();
    let stored: serde_json::Map<String, serde_json::Value> =
        tauri::async_runtime::block_on(async move {
            let pool = db_clone.ensure_pool().await?;
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT key, value_json FROM pkg_settings WHERE pkg_id = ?",
            )
            .bind(&pkg_for_query)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("read pkg_settings: {e}"))?;
            let mut obj = serde_json::Map::new();
            for (k, vj) in rows {
                let v: serde_json::Value =
                    serde_json::from_str(&vj).unwrap_or(serde_json::Value::String(vj));
                obj.insert(k, v);
            }
            Ok::<_, String>(obj)
        })?;

    // Merge: schema defaults provide the baseline, stored rows override.
    // Lets `pkg_settings_get` return a complete shape from first-launch even
    // before the user has set anything (registry doesn't pre-seed because the
    // pkg_settings.pkg_id FK isn't satisfied until kernel persists install).
    let mut merged = serde_json::Map::new();
    if let Some(fields) = &schema {
        for f in fields {
            merged.insert(f.key.clone(), f.default.clone());
        }
    }
    for (k, v) in stored {
        merged.insert(k, v);
    }

    Ok(PkgSettingsSnapshot {
        pkg_id,
        schema: serde_json::to_value(schema).unwrap_or(serde_json::Value::Null),
        values: serde_json::Value::Object(merged),
    })
}

#[tauri::command]
pub fn pkg_settings_set(
    db: State<'_, Arc<crate::commands::db::PaDb>>,
    pkg_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let db_clone = db.inner().clone();
    let value_json = serde_json::to_string(&value)
        .map_err(|e| format!("serialize value: {e}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    tauri::async_runtime::block_on(async move {
        let pool = db_clone.ensure_pool().await?;
        sqlx::query(
            "INSERT INTO pkg_settings (pkg_id, key, value_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(pkg_id, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
        )
        .bind(&pkg_id)
        .bind(&key)
        .bind(&value_json)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|e| format!("upsert pkg_settings: {e}"))?;
        Ok::<_, String>(())
    })?;
    Ok(())
}
