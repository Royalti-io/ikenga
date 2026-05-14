//! Claude-config (4-tier discovery) bridge endpoints.
//!
//! Mirrors the Tauri commands in `commands/claude_config.rs` over HTTP so
//! the `iyke` CLI and `mcp-iyke` MCP server can read the layered asset tree
//! and manage user pins without going through the Tauri surface.
//!
//! Phase 4 of the projects-first-class plan.

use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::claude::discovery::{self, AssetKind, AssetPin, AssetTree};
use crate::commands::db::PaDb;
use crate::commands::projects::get_active_project_id;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

fn map_err(e: String) -> (StatusCode, String) {
    let lower = e.to_lowercase();
    if lower.contains("not found") {
        err(StatusCode::NOT_FOUND, e)
    } else if lower.contains("invalid") || lower.contains("must be") {
        err(StatusCode::BAD_REQUEST, e)
    } else {
        err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}

// ── GET /iyke/claude/assets ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AssetsQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    /// Optional filter — one of skill|agent|command|hook|mcp. If set, only
    /// that map in the returned tree is populated.
    #[serde(default)]
    pub kind: Option<String>,
}

pub async fn get_claude_assets_list(
    Extension(db): Extension<Arc<PaDb>>,
    Extension(app): Extension<AppHandle>,
    Query(q): Query<AssetsQuery>,
) -> Result<Json<AssetTree>, (StatusCode, String)> {
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let project_id = match q.project_id {
        Some(id) => id,
        None => get_active_project_id(&pool).await.map_err(map_err)?,
    };
    let mut tree = discovery::discover(&project_id, &pool, &app)
        .await
        .map_err(map_err)?;

    if let Some(kind) = q.kind.as_deref() {
        let parsed = AssetKind::from_str(kind).ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                format!("invalid kind {kind:?}; expected one of skill|agent|command|hook|mcp"),
            )
        })?;
        // Keep only the requested map; clear the rest.
        match parsed {
            AssetKind::Skill => {
                tree.agents.clear();
                tree.commands.clear();
                tree.hooks.clear();
                tree.mcps.clear();
            }
            AssetKind::Agent => {
                tree.skills.clear();
                tree.commands.clear();
                tree.hooks.clear();
                tree.mcps.clear();
            }
            AssetKind::Command => {
                tree.skills.clear();
                tree.agents.clear();
                tree.hooks.clear();
                tree.mcps.clear();
            }
            AssetKind::Hook => {
                tree.skills.clear();
                tree.agents.clear();
                tree.commands.clear();
                tree.mcps.clear();
            }
            AssetKind::Mcp => {
                tree.skills.clear();
                tree.agents.clear();
                tree.commands.clear();
                tree.hooks.clear();
            }
        }
    }

    Ok(Json(tree))
}

// ── POST /iyke/claude/asset/pin ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct PinBody {
    pub scope: String,
    pub asset_kind: String,
    pub asset_name: String,
    pub preferred_tier: String,
    #[serde(default)]
    pub preferred_source: Option<String>,
}

pub async fn post_claude_asset_pin(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<PinBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    validate_scope(&body.scope).map_err(map_err)?;
    validate_kind(&body.asset_kind).map_err(map_err)?;
    validate_tier(&body.preferred_tier).map_err(map_err)?;
    if body.asset_name.is_empty() || body.asset_name.len() > 256 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid asset_name length"));
    }
    let pool = db.ensure_pool().await.map_err(map_err)?;
    sqlx::query(
        "INSERT INTO claude_asset_preferences
            (scope, asset_kind, asset_name, preferred_tier, preferred_source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, asset_kind, asset_name) DO UPDATE SET
            preferred_tier   = excluded.preferred_tier,
            preferred_source = excluded.preferred_source,
            updated_at       = excluded.updated_at",
    )
    .bind(&body.scope)
    .bind(&body.asset_kind)
    .bind(&body.asset_name)
    .bind(&body.preferred_tier)
    .bind(&body.preferred_source)
    .bind(now_ms())
    .execute(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("upsert pin: {e}")))?;
    Ok(Json(json!({ "ok": true })))
}

// ── POST /iyke/claude/asset/unpin ───────────────────────────────────────

#[derive(Deserialize)]
pub struct UnpinBody {
    pub scope: String,
    pub asset_kind: String,
    pub asset_name: String,
}

pub async fn post_claude_asset_unpin(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<UnpinBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    validate_scope(&body.scope).map_err(map_err)?;
    validate_kind(&body.asset_kind).map_err(map_err)?;
    let pool = db.ensure_pool().await.map_err(map_err)?;
    sqlx::query(
        "DELETE FROM claude_asset_preferences
         WHERE scope = ? AND asset_kind = ? AND asset_name = ?",
    )
    .bind(&body.scope)
    .bind(&body.asset_kind)
    .bind(&body.asset_name)
    .execute(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("delete pin: {e}")))?;
    Ok(Json(json!({ "ok": true })))
}

// ── GET /iyke/claude/asset/pins ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct ListPinsQuery {
    pub scope: String,
}

pub async fn get_claude_asset_pins(
    Extension(db): Extension<Arc<PaDb>>,
    Query(q): Query<ListPinsQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    validate_scope(&q.scope).map_err(map_err)?;
    let pool = db.ensure_pool().await.map_err(map_err)?;
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT scope, asset_kind, asset_name, preferred_tier, preferred_source, updated_at
         FROM claude_asset_preferences
         WHERE scope = ?
         ORDER BY asset_kind, asset_name",
    )
    .bind(&q.scope)
    .fetch_all(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("list pins: {e}")))?;
    let pins: Vec<AssetPin> = rows
        .into_iter()
        .map(|r| AssetPin {
            scope: r.get("scope"),
            asset_kind: r.get("asset_kind"),
            asset_name: r.get("asset_name"),
            preferred_tier: r.get("preferred_tier"),
            preferred_source: r.get("preferred_source"),
            updated_at: r.get("updated_at"),
        })
        .collect();
    Ok(Json(json!({ "pins": pins })))
}

// ── Validators (duplicated thin wrappers — the Tauri command file owns
// the canonical versions; we keep these local so the bridge can return
// HTTP-shaped errors without importing internal helpers). ──────────────

fn validate_scope(scope: &str) -> Result<(), String> {
    if scope == "workspace" {
        return Ok(());
    }
    if let Some(id) = scope.strip_prefix("project:") {
        if id.is_empty() || id.len() > 64 {
            return Err(format!("invalid project id length in scope {scope:?}"));
        }
        let mut chars = id.chars();
        let first = chars.next().unwrap();
        if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
            return Err(format!("invalid project id in scope {scope:?}"));
        }
        for c in chars {
            if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                return Err(format!("invalid project id in scope {scope:?}"));
            }
        }
        return Ok(());
    }
    Err(format!(
        "scope must be 'workspace' or 'project:<id>', got {scope:?}"
    ))
}

fn validate_tier(tier: &str) -> Result<(), String> {
    match tier {
        "personal" | "workspace_pkg" | "project" | "project_pkg" => Ok(()),
        _ => Err(format!(
            "preferred_tier must be one of personal|workspace_pkg|project|project_pkg, got {tier:?}"
        )),
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "skill" | "agent" | "command" | "hook" | "mcp" => Ok(()),
        _ => Err(format!(
            "asset_kind must be one of skill|agent|command|hook|mcp, got {kind:?}"
        )),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
