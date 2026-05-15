//! Named-session metadata for pkg-browser.
//!
//! The kernel's webview capability already gives each pkg per-partition
//! cookie/storage isolation (see `pkg/webview.rs::partition_dir` on
//! Linux/Win, `data_store_identifier` on macOS). What it doesn't track
//! is human-friendly session names — the partition slug is opaque, fine
//! for the kernel but hostile for callers ("which jar is `f3a1...`?").
//!
//! This module owns three HTTP endpoints (under `/iyke/browser/session/*`)
//! that record `(pkg_id, name) → partition` in SQLite. The MCP server
//! exposes them as `browser_session_create / list / delete` tools and
//! lets `browser_open` accept a `session` name in place of a raw
//! partition slug.
//!
//! Deleting a row does NOT touch the on-disk partition data — a future
//! create with the same partition slug picks the cookies back up. The
//! kernel cleans partitions only on pkg uninstall.

use axum::{
    extract::{Json as JsonBody, Query},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};

use crate::commands::db::PaDb;

// ── shapes ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SessionCreateBody {
    pub pkg_id: String,
    pub name: String,
    /// Optional partition slug. Defaults to a sanitized form of `name`.
    #[serde(default)]
    pub partition: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionDeleteBody {
    pub pkg_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct SessionListQuery {
    pub pkg_id: String,
}

/// Internal — body for `/iyke/browser/session/resolve`. Used by the MCP
/// in its `browser_open({session})` path: resolve name → partition first,
/// then call `open`. Also touches `last_used_at` so list-by-recent works.
#[derive(Debug, Deserialize)]
pub struct SessionResolveBody {
    pub pkg_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct BrowserSession {
    pub pkg_id: String,
    pub name: String,
    pub partition: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Serialize)]
pub struct SessionListResponse {
    pub sessions: Vec<BrowserSession>,
}

#[derive(Serialize)]
pub struct SessionResolveResponse {
    pub partition: String,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn err500<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
}

fn err404(msg: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::NOT_FOUND, msg.into())
}

fn err400(msg: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, msg.into())
}

fn sanitize_partition_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if ok {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn pool(pa: &PaDb) -> Result<sqlx::SqlitePool, (StatusCode, String)> {
    pa.ensure_pool().await.map_err(err500)
}

// ── handlers ────────────────────────────────────────────────────────────────

pub async fn post_browser_session_create(
    Extension(pa): Extension<std::sync::Arc<PaDb>>,
    JsonBody(body): JsonBody<SessionCreateBody>,
) -> Result<Json<BrowserSession>, (StatusCode, String)> {
    if body.name.trim().is_empty() {
        return Err(err400("session name must not be empty"));
    }
    let partition = body
        .partition
        .clone()
        .unwrap_or_else(|| sanitize_partition_slug(&body.name));
    let now = now_ms();

    let p = pool(&pa).await?;
    let inserted = sqlx::query_as::<_, BrowserSession>(
        "INSERT INTO browser_sessions (pkg_id, name, partition, created_at, last_used_at) \
         VALUES (?, ?, ?, ?, NULL) \
         RETURNING pkg_id, name, partition, created_at, last_used_at",
    )
    .bind(&body.pkg_id)
    .bind(&body.name)
    .bind(&partition)
    .bind(now)
    .fetch_one(&p)
    .await
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE") || msg.contains("PRIMARY KEY") {
            (
                StatusCode::CONFLICT,
                format!(
                    "session `{}` already exists for pkg `{}`",
                    body.name, body.pkg_id
                ),
            )
        } else {
            err500(e)
        }
    })?;
    Ok(Json(inserted))
}

pub async fn get_browser_session_list(
    Extension(pa): Extension<std::sync::Arc<PaDb>>,
    Query(q): Query<SessionListQuery>,
) -> Result<Json<SessionListResponse>, (StatusCode, String)> {
    let p = pool(&pa).await?;
    let sessions = sqlx::query_as::<_, BrowserSession>(
        "SELECT pkg_id, name, partition, created_at, last_used_at \
         FROM browser_sessions \
         WHERE pkg_id = ? \
         ORDER BY COALESCE(last_used_at, created_at) DESC",
    )
    .bind(&q.pkg_id)
    .fetch_all(&p)
    .await
    .map_err(err500)?;
    Ok(Json(SessionListResponse { sessions }))
}

pub async fn post_browser_session_delete(
    Extension(pa): Extension<std::sync::Arc<PaDb>>,
    JsonBody(body): JsonBody<SessionDeleteBody>,
) -> Result<Json<OkResponse>, (StatusCode, String)> {
    let p = pool(&pa).await?;
    let result = sqlx::query("DELETE FROM browser_sessions WHERE pkg_id = ? AND name = ?")
        .bind(&body.pkg_id)
        .bind(&body.name)
        .execute(&p)
        .await
        .map_err(err500)?;
    if result.rows_affected() == 0 {
        return Err(err404(format!(
            "no session `{}` for pkg `{}`",
            body.name, body.pkg_id
        )));
    }
    Ok(Json(OkResponse { ok: true }))
}

/// Resolve a session name to its partition slug. Side-effect: updates
/// `last_used_at`. Used by the MCP layer when `browser_open` is called
/// with `session` instead of `partition`.
pub async fn post_browser_session_resolve(
    Extension(pa): Extension<std::sync::Arc<PaDb>>,
    JsonBody(body): JsonBody<SessionResolveBody>,
) -> Result<Json<SessionResolveResponse>, (StatusCode, String)> {
    let p = pool(&pa).await?;
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE browser_sessions SET last_used_at = ? \
         WHERE pkg_id = ? AND name = ? \
         RETURNING partition",
    )
    .bind(now_ms())
    .bind(&body.pkg_id)
    .bind(&body.name)
    .fetch_optional(&p)
    .await
    .map_err(err500)?;

    match row {
        Some((partition,)) => Ok(Json(SessionResolveResponse { partition })),
        None => Err(err404(format!(
            "no session `{}` for pkg `{}`",
            body.name, body.pkg_id
        ))),
    }
}

// ── pure-function tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::sanitize_partition_slug;

    #[test]
    fn slug_handles_spaces() {
        assert_eq!(
            sanitize_partition_slug("Royalti Spotify"),
            "royalti-spotify"
        );
    }

    #[test]
    fn slug_collapses_runs() {
        assert_eq!(sanitize_partition_slug("A   B!?C"), "a-b-c");
    }

    #[test]
    fn slug_trims_edges() {
        assert_eq!(sanitize_partition_slug("--abc--"), "abc");
    }

    #[test]
    fn slug_fallback() {
        assert_eq!(sanitize_partition_slug("///"), "session");
    }
}
