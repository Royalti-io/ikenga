//! Iyke control-bridge endpoints for artifact pin comments.
//!
//! Exposes pin read + lifecycle transitions over the same localhost HTTP
//! surface the rest of the iyke bridge uses, so `mcp-iyke` can implement
//! `iyke_pin_read` / `iyke_pin_acknowledge` / `iyke_pin_resolve` as thin
//! HTTP forwards.
//!
//! Backed by the SQLite `artifact_comments` table (migration 0022). The
//! corresponding Tauri commands in `commands/comments.rs` are the same
//! surface from the frontend side — these handlers reuse the same SQL.

use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::db::PaDb;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

#[derive(Debug, Clone, Serialize)]
pub struct PinView {
    pub id: i64,
    pub artifact_path: String,
    pub selector: String,
    pub text: String,
    pub screenshot_path: Option<String>,
    pub status: String,
    pub position_x: Option<f64>,
    pub position_y: Option<f64>,
    pub thread_id: Option<String>,
    pub opening_session_id: Option<String>,
    pub sink: Option<String>,
    pub created_at: i64,
    pub acknowledged_at: Option<i64>,
    pub resolved_at: Option<i64>,
}

type PinRow = (
    i64,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<f64>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
);

fn row_to_view(row: PinRow) -> PinView {
    PinView {
        id: row.0,
        artifact_path: row.1,
        selector: row.2,
        text: row.3,
        screenshot_path: row.4,
        status: row.5,
        position_x: row.6,
        position_y: row.7,
        thread_id: row.8,
        opening_session_id: row.9,
        sink: row.10,
        created_at: row.11,
        acknowledged_at: row.12,
        resolved_at: row.13,
    }
}

const PIN_COLUMNS: &str = "id, artifact_path, selector, text, screenshot_path, status, \
    position_x, position_y, thread_id, opening_session_id, sink, \
    created_at, acknowledged_at, resolved_at";

#[derive(Deserialize)]
pub struct PinReadQuery {
    pub id: i64,
}

/// GET /iyke/pin/read?id=N — the canonical payload fetch path. Claude
/// receives a short prompt (`address pin #N`) from the routing dispatcher
/// and calls this to get the full structured context: artifact path,
/// selector, comment text, screenshot file path, and lifecycle status.
pub async fn get_pin_read(
    Extension(db): Extension<Arc<PaDb>>,
    Query(q): Query<PinReadQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let row: Option<PinRow> = sqlx::query_as(&format!(
        "SELECT {PIN_COLUMNS} FROM artifact_comments WHERE id = ?"
    ))
    .bind(q.id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("pin read: {e}")))?;
    match row {
        Some(r) => Ok(Json(serde_json::to_value(row_to_view(r)).unwrap_or(json!({})))),
        None => Err(err(StatusCode::NOT_FOUND, format!("pin {} not found", q.id))),
    }
}

#[derive(Deserialize)]
pub struct PinTransitionBody {
    pub id: i64,
}

/// POST /iyke/pin/acknowledge — transition open → in_progress.
///
/// Called by claude (via `mcp-iyke.pin_acknowledge`) when it starts acting
/// on a pin. Stamps `acknowledged_at` on the first transition; later calls
/// are idempotent (the stamp keeps its earliest value via COALESCE).
pub async fn post_pin_acknowledge(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<PinTransitionBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let now = now_millis();
    let res = sqlx::query(
        "UPDATE artifact_comments \
         SET status = 'in_progress', \
             acknowledged_at = COALESCE(acknowledged_at, ?) \
         WHERE id = ?",
    )
    .bind(now)
    .bind(body.id)
    .execute(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("pin ack: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(err(StatusCode::NOT_FOUND, format!("pin {} not found", body.id)));
    }
    fetch_view(&pool, body.id).await
}

/// POST /iyke/pin/resolve — transition any → resolved.
///
/// Called by claude (via `mcp-iyke.pin_resolve`) once the targeted change
/// is committed and the pin's intent is satisfied. The grid UI's manual
/// resolve goes through `comment_set_status('resolved')` instead and
/// converges on the same table state.
pub async fn post_pin_resolve(
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<PinTransitionBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let now = now_millis();
    let res = sqlx::query(
        "UPDATE artifact_comments \
         SET status = 'resolved', \
             resolved_at = COALESCE(resolved_at, ?) \
         WHERE id = ?",
    )
    .bind(now)
    .bind(body.id)
    .execute(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("pin resolve: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(err(StatusCode::NOT_FOUND, format!("pin {} not found", body.id)));
    }
    fetch_view(&pool, body.id).await
}

async fn fetch_view(
    pool: &sqlx::SqlitePool,
    id: i64,
) -> Result<Json<Value>, (StatusCode, String)> {
    let row: PinRow = sqlx::query_as(&format!(
        "SELECT {PIN_COLUMNS} FROM artifact_comments WHERE id = ?"
    ))
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("pin fetch: {e}")))?;
    Ok(Json(serde_json::to_value(row_to_view(row)).unwrap_or(json!({}))))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
