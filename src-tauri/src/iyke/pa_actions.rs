//! iyke bridge endpoint for the approve-gate producer hand-off (WP-8).
//!
//! `POST /iyke/pa-actions/pause` lets the mcp-iyke `pa_actions_pause` tool (and
//! any bridge client) pause a batch of drafts into the approve gate. It shares
//! the exact insert + `pa-action-paused` emit with the Tauri command via
//! `pa_actions_pause_inner`, so an MCP/CLI caller and the FE hit one code path.
//! `AppHandle` + `Arc<PaDb>` are already layered Extensions on every authed route.

use std::sync::Arc;

use axum::{http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::commands::db::PaDb;
use crate::commands::pa_actions::{pa_actions_pause_inner, PaPauseDraftInput};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausePayload {
    pub batch_id: String,
    pub action_id: String,
    pub drafts: Vec<PaPauseDraftInput>,
}

pub async fn post_pa_actions_pause(
    Extension(app): Extension<AppHandle>,
    Extension(db): Extension<Arc<PaDb>>,
    Json(body): Json<PausePayload>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let count = pa_actions_pause_inner(&app, &db, body.batch_id, body.action_id, body.drafts)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "ok": true, "count": count })))
}
