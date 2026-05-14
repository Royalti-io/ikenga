//! Layout-state bridge endpoints — Phase 6 of projects-first-class.
//!
//! `GET /iyke/layout/get?project_id=…` returns the persisted layout
//! blobs (pane tree, files-explorer, panel sizes) for a project, read
//! straight from the `layout_state` SQLite kv. Defaults to the active
//! project.
//!
//! `POST /iyke/layout/reset` deletes the three rows for a project,
//! returning the project to a "no saved layout" state. Used by the
//! Settings → Projects "Reset layout" button and the agent-facing
//! `iyke_layout_reset` MCP tool.

use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::db::PaDb;
use crate::commands::projects::get_active_project_id;

const PANE_TREE_KEY: &str = "workspace.pane-tree";
const FILES_EXPLORER_KEY: &str = "files.explorer.v1";
const PANEL_SIZES_KEY: &str = "workspace.panels";

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

fn map_err(e: String) -> (StatusCode, String) {
    let lower = e.to_lowercase();
    if lower.contains("not found") {
        err(StatusCode::NOT_FOUND, e)
    } else if lower.contains("invalid") || lower.contains("archived") {
        err(StatusCode::BAD_REQUEST, e)
    } else {
        err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}

fn scoped(key: &str, project_id: &str) -> String {
    format!("{key}.{project_id}")
}

#[derive(Deserialize)]
pub struct GetQuery {
    #[serde(default)]
    pub project_id: Option<String>,
}

pub async fn get_layout(
    Extension(db): Extension<Arc<PaDb>>,
    Query(q): Query<GetQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let project_id = match q.project_id {
        Some(id) => id,
        None => get_active_project_id(&pool).await.map_err(map_err)?,
    };

    let pane_tree = read_layout_row(&pool, &scoped(PANE_TREE_KEY, &project_id))
        .await
        .map_err(map_err)?;
    let files_explorer = read_layout_row(&pool, &scoped(FILES_EXPLORER_KEY, &project_id))
        .await
        .map_err(map_err)?;
    let panel_sizes = read_layout_row(&pool, &scoped(PANEL_SIZES_KEY, &project_id))
        .await
        .map_err(map_err)?;

    Ok(Json(json!({
        "project_id": project_id,
        "pane_tree": pane_tree,
        "files_explorer": files_explorer,
        "panel_sizes": panel_sizes,
    })))
}

#[derive(Deserialize)]
pub struct ResetBody {
    pub project_id: String,
}

pub async fn post_layout_reset(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<ResetBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.project_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "project_id is required"));
    }
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let mut deleted = 0u64;
    for key in [PANE_TREE_KEY, FILES_EXPLORER_KEY, PANEL_SIZES_KEY] {
        let scoped_key = scoped(key, &body.project_id);
        let r = sqlx::query("DELETE FROM layout_state WHERE key = ?")
            .bind(&scoped_key)
            .execute(&pool)
            .await
            .map_err(|e| map_err(e.to_string()))?;
        deleted += r.rows_affected();
    }
    Ok(Json(json!({
        "ok": true,
        "project_id": body.project_id,
        "deleted_rows": deleted,
    })))
}

async fn read_layout_row(pool: &sqlx::SqlitePool, key: &str) -> Result<Option<Value>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM layout_state WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match row {
        Some((raw,)) => match serde_json::from_str::<Value>(&raw) {
            Ok(v) => Ok(Some(v)),
            // Stored blob isn't valid JSON for some reason — return as a
            // string so the caller still sees *something*.
            Err(_) => Ok(Some(Value::String(raw))),
        },
        None => Ok(None),
    }
}
