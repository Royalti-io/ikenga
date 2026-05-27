//! Trust gating bridge endpoints — list, grant, revoke, preview.
//!
//! Phase 9 of the projects-first-class plan. Wraps `pkg::trust` so the FE
//! Settings → Pkgs route + the `iyke_pkg_trust_*` MCP tools share one
//! surface. Granting trust is a human-only action by design (the MCP
//! tool deliberately does NOT expose a grant entry); the bridge endpoint
//! exists for the FE only.

use std::sync::Arc;

use axum::{extract::Path, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::pkg::manifest::Package;
use crate::pkg::trust::{self, NeedsApprovalReason, PermsSummary, TrustState};

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

fn map_err(e: String) -> (StatusCode, String) {
    let lower = e.to_lowercase();
    if lower.contains("not found") {
        err(StatusCode::NOT_FOUND, e)
    } else if lower.contains("invalid") || lower.contains("mismatch") {
        err(StatusCode::BAD_REQUEST, e)
    } else {
        err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}

#[derive(Serialize)]
pub struct TrustEntryView {
    pub pkg_id: String,
    pub version: String,
    pub state: &'static str,
    /// Sensitive perms summary — what the dialog renders as "this package
    /// wants to". Always present; empty fields elided client-side.
    pub perms: PermsSummary,
    pub last_granted_at_ms: Option<i64>,
    /// Diff vs prior grant when state == "needs_approval" with reason
    /// `permissions_changed`. Otherwise None.
    pub change_reason: Option<NeedsApprovalReason>,
    /// True for `com.ikenga.*` builtins. UI renders "Built-in" with no
    /// Approve / Revoke action.
    pub auto_trusted: bool,
}

pub async fn get_trust_list(
    Extension(db): Extension<Arc<PaDb>>,
    Extension(app): Extension<AppHandle>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let kernel_state = app.state::<KernelState>();
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let app_data = app.path().app_data_dir().map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("app_data_dir: {e}"),
        )
    })?;

    let mut entries: Vec<TrustEntryView> = Vec::new();
    for s in kernel_state.0.list_installed() {
        let pkg = match Package::load(std::path::Path::new(&s.install_path)) {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "[iyke.trust] reload manifest for `{}` failed: {e:#} — skipping",
                    s.id
                );
                continue;
            }
        };
        let state = trust::evaluate(&pool, &pkg, &s.source, &app_data)
            .await
            .map_err(|e| {
                err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("evaluate `{}`: {e:#}", s.id),
                )
            })?;
        let summary = trust::summarize_sensitive(&pkg.manifest.permissions);
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
        entries.push(TrustEntryView {
            pkg_id: s.id.clone(),
            version,
            state: state_label,
            perms: summary,
            last_granted_at_ms,
            change_reason,
            auto_trusted,
        });
    }

    Ok(Json(json!({ "entries": entries })))
}

#[derive(Deserialize)]
pub struct GrantBody {
    pub pkg_id: String,
    /// The manifest version the FE saw when the user clicked Approve. We
    /// reload from disk and confirm it still matches — defends against an
    /// upgrade landing in the gap between the dialog opening and the user
    /// clicking through.
    pub version: String,
}

pub async fn post_trust_grant(
    Extension(db): Extension<Arc<PaDb>>,
    Extension(app): Extension<AppHandle>,
    Json(body): Json<GrantBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.pkg_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "pkg_id is required"));
    }
    let kernel_state = app.state::<KernelState>();
    let installed = kernel_state
        .0
        .installed_summary(&body.pkg_id)
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                format!("pkg `{}` not installed", body.pkg_id),
            )
        })?;
    let pkg = Package::load(std::path::Path::new(&installed.install_path)).map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("reload manifest: {e:#}"),
        )
    })?;
    if pkg.manifest.version != body.version {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!(
                "manifest version mismatch (FE saw `{}`, on-disk is `{}`) — re-open dialog",
                body.version, pkg.manifest.version
            ),
        ));
    }
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let summary = trust::summarize_sensitive(&pkg.manifest.permissions);
    trust::grant(&pool, &pkg.manifest.id, &pkg.manifest.version, &summary)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("grant: {e:#}")))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RevokeBody {
    pub pkg_id: String,
}

pub async fn post_trust_revoke(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<RevokeBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.pkg_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "pkg_id is required"));
    }
    let pool = db.ensure_pool().await.map_err(map_err)?;
    trust::revoke(&pool, &body.pkg_id)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("revoke: {e:#}")))?;
    Ok(Json(json!({ "ok": true })))
}

/// Plain-English-ish preview for the dialog: the sensitive perms set the
/// user is being asked to approve. Same shape as the `perms` field on
/// `TrustEntryView`; this endpoint is a per-pkg variant for the dialog
/// open path so the FE can fetch it lazily without re-listing everything.
pub async fn get_trust_preview(
    Extension(app): Extension<AppHandle>,
    Path(pkg_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let kernel_state = app.state::<KernelState>();
    let installed = kernel_state.0.installed_summary(&pkg_id).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            format!("pkg `{pkg_id}` not installed"),
        )
    })?;
    let pkg = Package::load(std::path::Path::new(&installed.install_path)).map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("reload manifest: {e:#}"),
        )
    })?;
    let summary = trust::summarize_sensitive(&pkg.manifest.permissions);
    Ok(Json(json!({
        "pkg_id": pkg_id,
        "version": pkg.manifest.version,
        "perms": summary,
    })))
}
