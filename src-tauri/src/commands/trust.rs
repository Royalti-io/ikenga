//! Phase 9 — Tauri command surface for trust gating.
//!
//! Thin wrappers around `pkg::trust` so the frontend's Settings → Pkgs
//! Trust column can list / preview / grant / revoke without going through
//! the iyke HTTP server. Same enforcement and same storage as the bridge
//! endpoints in `iyke::trust`; the bridge handlers exist for external CLI
//! callers and `mcp-iyke`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::pkg::manifest::Package;
use crate::pkg::trust::{self, NeedsApprovalReason, PermsSummary, TrustState};

#[derive(Serialize, Clone)]
pub struct TrustEntry {
    pub pkg_id: String,
    pub version: String,
    pub state: &'static str,
    pub perms: PermsSummary,
    pub last_granted_at_ms: Option<i64>,
    pub change_reason: Option<NeedsApprovalReason>,
    pub auto_trusted: bool,
}

async fn evaluate_one(
    pool: &sqlx::SqlitePool,
    s: &crate::pkg::InstalledSummary,
    app_data: &std::path::PathBuf,
) -> Result<Option<TrustEntry>, String> {
    let pkg = match Package::load(std::path::Path::new(&s.install_path)) {
        Ok(p) => p,
        Err(e) => {
            log::warn!(
                "[trust] reload manifest for `{}` failed: {e:#} — skipping",
                s.id
            );
            return Ok(None);
        }
    };
    let state = trust::evaluate(pool, &pkg, &s.source, app_data)
        .await
        .map_err(|e| format!("evaluate `{}`: {e:#}", s.id))?;
    let perms = trust::summarize_sensitive(&pkg.manifest.permissions);
    let auto_trusted = matches!(state, TrustState::AutoTrusted);
    let (state_label, last_granted_at_ms, version, change_reason) = match state {
        TrustState::AutoTrusted => ("auto_trusted", None, pkg.manifest.version.clone(), None),
        TrustState::AutoGranted => ("auto_granted", None, pkg.manifest.version.clone(), None),
        TrustState::Granted {
            version,
            granted_at_ms,
        } => ("granted", Some(granted_at_ms), version, None),
        TrustState::NeedsApproval {
            reason,
            current_version,
        } => ("needs_approval", None, current_version, Some(reason)),
    };
    Ok(Some(TrustEntry {
        pkg_id: s.id.clone(),
        version,
        state: state_label,
        perms,
        last_granted_at_ms,
        change_reason,
        auto_trusted,
    }))
}

#[tauri::command]
pub async fn pkg_trust_list(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    kernel: State<'_, KernelState>,
) -> Result<Vec<TrustEntry>, String> {
    let pool = db.ensure_pool().await?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for s in kernel.0.list_installed() {
        if let Some(entry) = evaluate_one(&pool, &s, &app_data).await? {
            out.push(entry);
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct TrustPreview {
    pub pkg_id: String,
    pub version: String,
    pub perms: PermsSummary,
}

#[tauri::command]
pub async fn pkg_trust_preview(
    kernel: State<'_, KernelState>,
    pkg_id: String,
) -> Result<TrustPreview, String> {
    let installed = kernel
        .0
        .installed_summary(&pkg_id)
        .ok_or_else(|| format!("pkg `{pkg_id}` not installed"))?;
    let pkg = Package::load(std::path::Path::new(&installed.install_path))
        .map_err(|e| format!("reload manifest: {e:#}"))?;
    let perms = trust::summarize_sensitive(&pkg.manifest.permissions);
    Ok(TrustPreview {
        pkg_id,
        version: pkg.manifest.version,
        perms,
    })
}

#[tauri::command]
pub async fn pkg_trust_grant(
    db: State<'_, Arc<PaDb>>,
    kernel: State<'_, KernelState>,
    pkg_id: String,
    version: String,
) -> Result<(), String> {
    let installed = kernel
        .0
        .installed_summary(&pkg_id)
        .ok_or_else(|| format!("pkg `{pkg_id}` not installed"))?;
    let pkg = Package::load(std::path::Path::new(&installed.install_path))
        .map_err(|e| format!("reload manifest: {e:#}"))?;
    if pkg.manifest.version != version {
        return Err(format!(
            "manifest version mismatch (FE saw `{}`, on-disk is `{}`) — re-open dialog",
            version, pkg.manifest.version
        ));
    }
    let pool = db.ensure_pool().await?;
    let summary = trust::summarize_sensitive(&pkg.manifest.permissions);
    trust::grant(&pool, &pkg.manifest.id, &pkg.manifest.version, &summary)
        .await
        .map_err(|e| format!("grant: {e:#}"))?;
    Ok(())
}

#[tauri::command]
pub async fn pkg_trust_revoke(db: State<'_, Arc<PaDb>>, pkg_id: String) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    trust::revoke(&pool, &pkg_id)
        .await
        .map_err(|e| format!("revoke: {e:#}"))?;
    Ok(())
}
