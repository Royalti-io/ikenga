//! Read-only bridge endpoint for the `pkg_permission_violations` audit
//! table. Phase 3 of `2026-05-15-runtime-acl-enforcement`.
//!
//! Mirrors `commands::permissions_audit::pkg_permission_violations_list` —
//! same query shape, same row shape. Clear is intentionally not exposed
//! over the bridge: it's a human-only action via Settings → Pkgs, parallel
//! to Phase 9's "granting trust is human-only" decision.

use std::sync::Arc;

use axum::{
    extract::Query,
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use crate::commands::db::PaDb;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

#[derive(Serialize)]
pub struct ViolationRowView {
    pub id: i64,
    pub pkg_id: String,
    pub scope_kind: String,
    pub attempted: String,
    pub declared: String,
    pub occurred_at: i64,
}

#[derive(Deserialize)]
pub struct ListParams {
    pub pkg_id: Option<String>,
    pub limit: Option<i64>,
}

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 1000;

pub async fn get_violations_list(
    Extension(db): Extension<Arc<PaDb>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let lim = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let rows = if let Some(id) = params.pkg_id.as_deref() {
        sqlx::query(
            "SELECT id, pkg_id, scope_kind, attempted, declared, occurred_at
             FROM pkg_permission_violations
             WHERE pkg_id = ?
             ORDER BY occurred_at DESC
             LIMIT ?",
        )
        .bind(id)
        .bind(lim)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            "SELECT id, pkg_id, scope_kind, attempted, declared, occurred_at
             FROM pkg_permission_violations
             ORDER BY occurred_at DESC
             LIMIT ?",
        )
        .bind(lim)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("query pkg_permission_violations: {e:#}"),
        )
    })?;

    let entries: Vec<ViolationRowView> = rows
        .into_iter()
        .map(|r| ViolationRowView {
            id: r.get::<i64, _>("id"),
            pkg_id: r.get::<String, _>("pkg_id"),
            scope_kind: r.get::<String, _>("scope_kind"),
            attempted: r.get::<String, _>("attempted"),
            declared: r.get::<String, _>("declared"),
            occurred_at: r.get::<i64, _>("occurred_at"),
        })
        .collect();

    Ok(Json(json!({ "entries": entries })))
}
