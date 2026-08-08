//! Chi-first agent surface.
//!
//! WP-01: a thin cache-backed command surface for running, resuming, listing,
//! and cancelling agent sessions. Engine-specific spawn logic is intentionally
//! left to WP-02; this file only mints run ids, persists cache rows, and reads
//! the cache. Agent records are the source of truth for session history.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, State};

use crate::commands::db::PaDb;

/// Cache state. Lives in `app_data_dir` and is `.manage()`d in `lib.rs`.
#[derive(Clone, Debug)]
pub struct ChiCache {
    app_data_dir: PathBuf,
}

impl ChiCache {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    /// `<app-data-dir>/chi-cache/`
    pub fn cache_dir(&self) -> PathBuf {
        self.app_data_dir.join("chi-cache")
    }

    /// Per-run artifact / output tail file.
    pub fn run_output_path(&self, run_id: &str) -> PathBuf {
        self.cache_dir().join(format!("{run_id}.json"))
    }

    /// Ensure the JSON cache directory exists.
    pub fn ensure_cache_dir(&self) -> Result<(), String> {
        std::fs::create_dir_all(self.cache_dir()).map_err(|e| format!("chi-cache dir: {e}"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChiRunOpts {
    pub engine_id: String,
    pub prompt: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    #[allow(dead_code)]
    pub timeout_seconds: Option<u32>, // reserved; not yet persisted in chi_cache
    pub parent_id: Option<String>,
    #[serde(rename = "resumeSessionId")]
    pub resume_session_id: Option<String>,
}

#[derive(Serialize)]
pub struct ChiRunResult {
    pub run_id: String,
    pub status: String,
    pub output: Option<String>,
    pub output_truncated: Option<bool>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ChiCacheRow {
    pub run_id: String,
    pub engine_id: String,
    pub external_id: Option<String>,
    pub brief: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub status: String,
    pub output_path: Option<String>,
    pub output_truncated: Option<bool>,
    pub error: Option<String>,
    pub artifacts: Option<serde_json::Value>,
    pub parent_id: Option<String>,
    pub owner: String,
    pub terminal_session_id: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub expires_at: Option<String>,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn one_hour_from_now_iso() -> String {
    chrono::Utc::now()
        .checked_add_signed(chrono::TimeDelta::hours(1))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Convert a SQLite row into a `ChiCacheRow`. Explicit typing keeps sqlx happy
/// when the query is built from a `&'static str`.
fn row_to_cache_row(r: &sqlx::sqlite::SqliteRow) -> Result<ChiCacheRow, String> {
    let artifacts: Option<String> = r.try_get("artifacts").ok().flatten();
    let artifacts = artifacts.and_then(|s| serde_json::from_str(&s).ok());

    let output_truncated: Option<i64> = r.try_get("output_truncated").ok().flatten();
    let output_truncated = output_truncated.map(|v| v != 0);

    Ok(ChiCacheRow {
        run_id: r.get("run_id"),
        engine_id: r.get("engine_id"),
        external_id: r.get("external_id"),
        brief: r.get("brief"),
        cwd: r.get("cwd"),
        model: r.get("model"),
        mode: r.get("mode"),
        status: r.get("status"),
        output_path: r.get("output_path"),
        output_truncated,
        error: r.get("error"),
        artifacts,
        parent_id: r.get("parent_id"),
        owner: r.get("owner"),
        terminal_session_id: r.get("terminal_session_id"),
        started_at: r.get("started_at"),
        ended_at: r.get("ended_at"),
        last_seen_at: r.get("last_seen_at"),
        expires_at: r.get("expires_at"),
    })
}

/// Upsert a cache row from the options. Returns the run_id.
async fn cache_insert(
    db: &PaDb,
    run_id: &str,
    opts: &ChiRunOpts,
    output_path: &Path,
    owner: &str,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let now = now_iso();
    let expires = one_hour_from_now_iso();
    let output_path_string = output_path.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO chi_cache (
            run_id, engine_id, external_id, brief, cwd, model, mode, status,
            output_path, output_truncated, error, artifacts, parent_id, owner,
            terminal_session_id, started_at, ended_at, last_seen_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(run_id)
    .bind(&opts.engine_id)
    .bind(&opts.resume_session_id) // initial external_id is the resume id, if any
    .bind(&opts.prompt)
    .bind(&opts.cwd)
    .bind(&opts.model)
    .bind(&opts.mode)
    .bind("queued")
    .bind(output_path_string)
    .bind(0i64) // output_truncated; boolean stored as integer
    .bind::<Option<String>>(None)
    .bind::<Option<String>>(None) // artifacts as JSON string
    .bind(&opts.parent_id)
    .bind(owner)
    .bind::<Option<String>>(None)
    .bind(&now)
    .bind::<Option<String>>(None)
    .bind(&now)
    .bind(&expires)
    .execute(&pool)
    .await
    .map_err(|e| format!("chi_cache insert: {e}"))?;
    Ok(())
}

async fn cache_get(db: &PaDb, run_id: &str) -> Result<Option<ChiCacheRow>, String> {
    let pool = db.ensure_pool().await?;
    let row = sqlx::query(
        "SELECT run_id, engine_id, external_id, brief, cwd, model, mode, status,
                output_path, output_truncated, error, artifacts, parent_id, owner,
                terminal_session_id, started_at, ended_at, last_seen_at, expires_at
         FROM chi_cache WHERE run_id = ?",
    )
    .bind(run_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("chi_cache get: {e}"))?;

    row.as_ref().map(row_to_cache_row).transpose()
}

async fn cache_list(
    db: &PaDb,
    engine_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ChiCacheRow>, String> {
    let pool = db.ensure_pool().await?;
    let rows = if let Some(engine) = engine_id {
        sqlx::query(
            "SELECT run_id, engine_id, external_id, brief, cwd, model, mode, status,
                    output_path, output_truncated, error, artifacts, parent_id, owner,
                    terminal_session_id, started_at, ended_at, last_seen_at, expires_at
             FROM chi_cache
             WHERE engine_id = ?
             ORDER BY last_seen_at DESC
             LIMIT ?",
        )
        .bind(engine)
        .bind(limit)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            "SELECT run_id, engine_id, external_id, brief, cwd, model, mode, status,
                    output_path, output_truncated, error, artifacts, parent_id, owner,
                    terminal_session_id, started_at, ended_at, last_seen_at, expires_at
             FROM chi_cache
             ORDER BY last_seen_at DESC
             LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| format!("chi_cache list: {e}"))?;

    rows.iter().map(row_to_cache_row).collect()
}

async fn cache_update_status(
    db: &PaDb,
    run_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let now = now_iso();
    sqlx::query("UPDATE chi_cache SET status = ?, error = ?, last_seen_at = ? WHERE run_id = ?")
        .bind(status)
        .bind(error)
        .bind(&now)
        .bind(run_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("chi_cache update status: {e}"))?;
    Ok(())
}

/// Run a Chi. WP-01: mints a run id, persists a cache row, and returns a queued
/// result. WP-02 will wire the engine spawn and update the row as the run
/// progresses.
#[tauri::command]
pub async fn chi_run(
    _app: AppHandle,
    db: State<'_, PaDb>,
    cache: State<'_, ChiCache>,
    opts: ChiRunOpts,
) -> Result<ChiRunResult, String> {
    cache.ensure_cache_dir()?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let output_path = cache.run_output_path(&run_id);

    // Initial one-off TTL is 1 hour; long-lived sessions will refresh this.
    cache_insert(&db, &run_id, &opts, &output_path, "cli").await?;

    Ok(ChiRunResult {
        run_id,
        status: "queued".to_string(),
        output: None,
        output_truncated: None,
        error: None,
    })
}

/// Resume an existing Chi session using its engine-native `external_id`.
/// WP-01: validates the cache row exists and updates `last_seen_at`.
#[tauri::command]
pub async fn chi_resume(
    _app: AppHandle,
    db: State<'_, PaDb>,
    #[allow(non_snake_case)] runId: String,
    _prompt: String,
) -> Result<ChiRunResult, String> {
    let run_id = runId;
    let row = cache_get(&db, &run_id)
        .await?
        .ok_or_else(|| format!("chi run not found: {run_id}"))?;

    cache_update_status(&db, &run_id, "running", None).await?;

    Ok(ChiRunResult {
        run_id: row.run_id,
        status: "running".to_string(),
        output: None,
        output_truncated: None,
        error: None,
    })
}

/// Read the status of a Chi run from the cache. WP-02 will merge agent-native
/// records for live status and output.
#[tauri::command]
pub async fn chi_status(
    db: State<'_, PaDb>,
    #[allow(non_snake_case)] runId: String,
) -> Result<ChiRunResult, String> {
    let run_id = runId;
    let row = cache_get(&db, &run_id)
        .await?
        .ok_or_else(|| format!("chi run not found: {run_id}"))?;

    Ok(ChiRunResult {
        run_id: row.run_id,
        status: row.status,
        output: None, // WP-02: read from output_path / agent records
        output_truncated: row.output_truncated,
        error: row.error,
    })
}

/// List cached Chi runs, optionally filtered by engine. WP-02 will merge with
/// agent-native session records.
#[tauri::command]
pub async fn chi_list(
    db: State<'_, PaDb>,
    #[allow(non_snake_case)] engineId: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ChiCacheRow>, String> {
    let engine_id = engineId.as_deref();
    cache_list(&db, engine_id, limit.unwrap_or(50).clamp(1, 200)).await
}

/// Cancel a Chi run. WP-02 will kill the engine child process.
#[tauri::command]
pub async fn chi_cancel(
    db: State<'_, PaDb>,
    #[allow(non_snake_case)] runId: String,
) -> Result<ChiRunResult, String> {
    let run_id = runId;
    let row = cache_get(&db, &run_id)
        .await?
        .ok_or_else(|| format!("chi run not found: {run_id}"))?;

    cache_update_status(&db, &run_id, "cancelled", None).await?;

    Ok(ChiRunResult {
        run_id: row.run_id,
        status: "cancelled".to_string(),
        output: None,
        output_truncated: None,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> PaDb {
        let file_name = format!("ikenga-chi-test-{}.db", uuid::Uuid::new_v4());
        let db_path = std::env::temp_dir().join(file_name);
        PaDb::new(db_path)
    }

    #[tokio::test]
    async fn chi_cache_round_trip() {
        let db = test_db().await;
        let cache = ChiCache::new(std::env::temp_dir());
        cache.ensure_cache_dir().unwrap();

        let run_id = uuid::Uuid::new_v4().to_string();
        let output_path = cache.run_output_path(&run_id);
        let opts = ChiRunOpts {
            engine_id: "claude-code".into(),
            prompt: "hello".into(),
            cwd: Some("/tmp".into()),
            model: None,
            mode: None,
            timeout_seconds: None,
            parent_id: None,
            resume_session_id: None,
        };

        cache_insert(&db, &run_id, &opts, &output_path, "cli")
            .await
            .unwrap();

        let row = cache_get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.run_id, run_id);
        assert_eq!(row.engine_id, "claude-code");
        assert_eq!(row.status, "queued");
        assert_eq!(row.cwd.as_deref(), Some("/tmp"));

        cache_update_status(&db, &run_id, "running", None)
            .await
            .unwrap();
        let row = cache_get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, "running");
        assert!(row.last_seen_at.is_some());

        let rows = cache_list(&db, None, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].run_id, run_id);
    }
}
