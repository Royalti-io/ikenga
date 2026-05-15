//! Durable key-value settings store. Backed by `settings_kv` table
//! (migration 0013). Used as the authoritative mirror for user
//! preferences that frontend Zustand stores also persist to
//! localStorage — see `src/lib/shell/shell-store.ts` and
//! `src/lib/ikenga/theme-store.ts` for the consumers.
//!
//! Values are JSON strings — typing is enforced in TS, not here.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use super::db::PaDb;

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn settings_get(db: State<'_, Arc<PaDb>>, key: String) -> Result<Option<String>, String> {
    let pool = db.ensure_pool().await?;
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings_kv WHERE key = ?")
        .bind(&key)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("settings_get: {e}"))?;
    Ok(row.map(|(v,)| v))
}

#[tauri::command]
pub async fn settings_set(
    db: State<'_, Arc<PaDb>>,
    key: String,
    value: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    sqlx::query(
        "INSERT INTO settings_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&key)
    .bind(&value)
    .bind(now_ms())
    .execute(&pool)
    .await
    .map_err(|e| format!("settings_set: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn settings_get_all(db: State<'_, Arc<PaDb>>) -> Result<HashMap<String, String>, String> {
    let pool = db.ensure_pool().await?;
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings_kv")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("settings_get_all: {e}"))?;
    Ok(rows.into_iter().collect())
}

#[tauri::command]
pub async fn settings_clear_all(db: State<'_, Arc<PaDb>>) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    sqlx::query("DELETE FROM settings_kv")
        .execute(&pool)
        .await
        .map_err(|e| format!("settings_clear_all: {e}"))?;
    Ok(())
}
