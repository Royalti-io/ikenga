//! SQLite commands. Thin wrappers over tauri-plugin-sql's connection pool.
//!
//! tauri-plugin-sql exposes JS bindings directly (the frontend can do
//! `Database.load("sqlite:pa.db").then(db => db.execute(...))`), but we
//! re-expose `db_query` / `db_exec` as Tauri commands so callers that prefer
//! the typed wrapper in `tauri-cmd.ts` don't have to manage their own DB
//! handle.
//!
//! TODO(phase-1-integration): tauri-plugin-sql's `DbInstances` state type is
//! `Mutex<HashMap<String, DbPool>>` but `DbPool` is private. The cleanest path
//! is to call into the plugin's exposed JS commands from Rust via the plugin
//! handle, but that's awkward. For now we hold our own `sqlx::SqlitePool`
//! pointed at the same file the plugin manages and use `sqlx` directly.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

pub struct PaDb {
    pool: Mutex<Option<sqlx::SqlitePool>>,
    db_path: PathBuf,
}

impl PaDb {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            pool: Mutex::new(None),
            db_path,
        }
    }

    pub fn db_path_for_diag(&self) -> &PathBuf {
        &self.db_path
    }

    pub async fn ensure_pool(&self) -> Result<sqlx::SqlitePool, String> {
        let mut guard = self.pool.lock().await;
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
        // Make sure parent dir + file exist so sqlx can open it.
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let url = format!("sqlite://{}?mode=rwc", self.db_path.display());
        let pool = sqlx::SqlitePool::connect(&url)
            .await
            .map_err(|e| format!("sqlite connect: {e}"))?;
        // Apply migrations idempotently. tauri-plugin-sql's migration runner
        // only fires when JS calls Database.load(), and that path has been
        // observed to silently hang (see raceTimeout in workspace.tsx). When
        // it times out, pa.db stays schema-less and every Rust-side query
        // fails with "no such table". Running migrations on the Rust pool
        // makes the schema guaranteed regardless of plugin behavior.
        ensure_schema(&pool).await?;
        *guard = Some(pool.clone());
        Ok(pool)
    }
}

/// Embedded migration set, kept in lockstep with `migrations/*.sql`. Tracked
/// in a `_pa_migrations` table so each migration runs exactly once. SQL files
/// are split on `;\n` so multi-statement files execute one statement at a
/// time (sqlx's `query()` doesn't support multi-statement input).
async fn ensure_schema(pool: &sqlx::SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _pa_migrations (
            id INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("migrations table: {e}"))?;

    let applied: Vec<i64> = sqlx::query_scalar("SELECT id FROM _pa_migrations")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("read applied migrations: {e}"))?;
    let applied: std::collections::HashSet<i64> = applied.into_iter().collect();

    let migrations: &[(i64, &str, &str)] = &[
        (
            1,
            "0001_init",
            include_str!("../../migrations/0001_init.sql"),
        ),
        (
            2,
            "0002_viewer_recents",
            include_str!("../../migrations/0002_viewer_recents.sql"),
        ),
        (
            3,
            "0003_claude_sessions",
            include_str!("../../migrations/0003_claude_sessions.sql"),
        ),
        // 0004 (render_queue), 0005 (mbox_sync), 0006 (storyboards) created
        // app-specific schema that was retired with the strip-down. We keep
        // the SQL files in `migrations/` so existing dev DBs still apply
        // them in version order before 0009 cleans them up; fresh installs
        // run 0001→0003 then 0007→0009 (no app-specific tables ever exist).
        (
            4,
            "0004_render_queue",
            include_str!("../../migrations/0004_render_queue.sql"),
        ),
        (
            5,
            "0005_mbox_sync",
            include_str!("../../migrations/0005_mbox_sync.sql"),
        ),
        (
            6,
            "0006_storyboards",
            include_str!("../../migrations/0006_storyboards.sql"),
        ),
        (
            7,
            "0007_pkg_kernel",
            include_str!("../../migrations/0007_pkg_kernel.sql"),
        ),
        (
            8,
            "0008_pkg_install_source",
            include_str!("../../migrations/0008_pkg_install_source.sql"),
        ),
        (
            9,
            "0009_strip_legacy",
            include_str!("../../migrations/0009_strip_legacy.sql"),
        ),
        (
            10,
            "0010_activity_bar_pinning",
            include_str!("../../migrations/0010_activity_bar_pinning.sql"),
        ),
        (
            11,
            "0011_chat_sessions",
            include_str!("../../migrations/0011_chat_sessions.sql"),
        ),
        (
            12,
            "0012_session_fork",
            include_str!("../../migrations/0012_session_fork.sql"),
        ),
        (
            13,
            "0013_settings_kv",
            include_str!("../../migrations/0013_settings_kv.sql"),
        ),
        (
            14,
            "0014_browser_sessions",
            include_str!("../../migrations/0014_browser_sessions.sql"),
        ),
        (
            15,
            "0015_projects",
            include_str!("../../migrations/0015_projects.sql"),
        ),
        (
            16,
            "0016_iyke_memory",
            include_str!("../../migrations/0016_iyke_memory.sql"),
        ),
        (
            17,
            "0017_claude_asset_preferences",
            include_str!("../../migrations/0017_claude_asset_preferences.sql"),
        ),
        (
            18,
            "0018_pkg_trust_versioning",
            include_str!("../../migrations/0018_pkg_trust_versioning.sql"),
        ),
        (
            19,
            "0019_artifact_pin_metadata",
            include_str!("../../migrations/0019_artifact_pin_metadata.sql"),
        ),
        (
            20,
            "0020_pkg_permission_violations",
            include_str!("../../migrations/0020_pkg_permission_violations.sql"),
        ),
        (
            21,
            "0021_pkg_capability_snapshots",
            include_str!("../../migrations/0021_pkg_capability_snapshots.sql"),
        ),
        (
            22,
            "0022_artifact_comments",
            include_str!("../../migrations/0022_artifact_comments.sql"),
        ),
        (
            23,
            "0023_studio_threads",
            include_str!("../../migrations/0023_studio_threads.sql"),
        ),
    ];

    for (id, name, sql) in migrations {
        if applied.contains(id) {
            continue;
        }
        for stmt in split_statements(sql) {
            if stmt.trim().is_empty() {
                continue;
            }
            // 0003 uses ALTER TABLE ADD COLUMN which errors with "duplicate
            // column name" if the column already exists. That can happen
            // when the JS plugin's migration ran before this one. Treat
            // those as already-applied and continue.
            if let Err(e) = sqlx::query(&stmt).execute(pool).await {
                let msg = e.to_string();
                if msg.contains("duplicate column name") || msg.contains("already exists") {
                    log::debug!("migration {name} stmt skipped: {msg}");
                    continue;
                }
                return Err(format!("migration {name} stmt failed: {msg}"));
            }
        }
        sqlx::query("INSERT INTO _pa_migrations (id, applied_at) VALUES (?, ?)")
            .bind(id)
            .bind(now_ms())
            .execute(pool)
            .await
            .map_err(|e| format!("record migration {name}: {e}"))?;
        log::info!("applied migration {name}");
    }

    // Post-migration bootstrap: ensure the Default project exists and
    // backfill project_id on tables added by 0015. Idempotent.
    bootstrap_default_project(pool).await?;

    Ok(())
}

/// Ensure the Default project row exists and backfill project_id columns
/// added by 0015_projects.sql. Runs after every schema apply; cheap when
/// already done (INSERT OR IGNORE + UPDATE … WHERE project_id IS NULL).
async fn bootstrap_default_project(pool: &sqlx::SqlitePool) -> Result<(), String> {
    let now = now_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO projects
            (id, display_name, root_path, icon, color, description, position, is_default, created_at)
         VALUES ('default', 'Default', NULL, NULL, '#7c7c7c', NULL, 0, 1, ?)",
    )
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("seed default project: {e}"))?;

    for table in [
        "chat_threads",
        "pkg_installed",
        "layout_state",
        "browser_sessions",
    ] {
        let sql = format!("UPDATE {table} SET project_id = 'default' WHERE project_id IS NULL");
        sqlx::query(&sql)
            .execute(pool)
            .await
            .map_err(|e| format!("backfill {table}.project_id: {e}"))?;
    }

    // Phase 4: promote any legacy `claudeProjectRoots` entries to first-class
    // `projects` rows. Idempotent (settings_kv-gated). Errors are logged but
    // never block boot — a bad row shouldn't lock the user out.
    if let Err(e) = crate::commands::projects::claude_roots_to_projects_migration_v1(pool).await {
        log::warn!("[claude-roots-migration] failed: {e}");
    }

    Ok(())
}

fn split_statements(sql: &str) -> Vec<String> {
    // Tiny statement splitter — strips line/block comments, then splits on `;`
    // outside of single-quoted strings. Good enough for our hand-written
    // schema files (no triggers, no embedded semicolons in literals beyond
    // the obvious cases).
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut in_string = false;
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if !in_string {
            // Strip `-- line comment` to end of line.
            if c == '-' && chars.peek() == Some(&'-') {
                for ch in chars.by_ref() {
                    if ch == '\n' {
                        break;
                    }
                }
                continue;
            }
        }
        if c == '\'' {
            in_string = !in_string;
            buf.push(c);
        } else if c == ';' && !in_string {
            out.push(buf.trim().to_string());
            buf.clear();
        } else {
            buf.push(c);
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn bind_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    q.bind(i)
                } else if let Some(f) = n.as_f64() {
                    q.bind(f)
                } else {
                    q.bind(n.to_string())
                }
            }
            Value::String(s) => q.bind(s.clone()),
            Value::Array(arr) => {
                // Treat byte arrays as Vec<u8>.
                let bytes: Vec<u8> = arr
                    .iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                    .collect();
                q.bind(bytes)
            }
            other => q.bind(other.to_string()),
        };
    }
    q
}

#[tauri::command]
pub async fn db_query(
    db: State<'_, Arc<PaDb>>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Value>, String> {
    use sqlx::{Column, Row, TypeInfo, ValueRef};

    let pool = db.ensure_pool().await?;
    let q = bind_params(sqlx::query(&sql), &params);
    let rows = q
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut obj = Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let name = col.name().to_string();
            let raw = row.try_get_raw(i).map_err(|e| format!("get_raw: {e}"))?;
            let val = if raw.is_null() {
                Value::Null
            } else {
                match raw.type_info().name() {
                    "INTEGER" | "INT" | "BIGINT" => row
                        .try_get::<i64, _>(i)
                        .ok()
                        .map(Value::from)
                        .unwrap_or(Value::Null),
                    "REAL" | "FLOAT" | "DOUBLE" => row
                        .try_get::<f64, _>(i)
                        .ok()
                        .and_then(|v| serde_json::Number::from_f64(v).map(Value::Number))
                        .unwrap_or(Value::Null),
                    "BOOLEAN" => row
                        .try_get::<bool, _>(i)
                        .ok()
                        .map(Value::Bool)
                        .unwrap_or(Value::Null),
                    "BLOB" => row
                        .try_get::<Vec<u8>, _>(i)
                        .ok()
                        .map(|b| Value::Array(b.into_iter().map(Value::from).collect()))
                        .unwrap_or(Value::Null),
                    _ => row
                        .try_get::<String, _>(i)
                        .ok()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                }
            };
            obj.insert(name, val);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

#[tauri::command]
pub async fn db_exec(
    db: State<'_, Arc<PaDb>>,
    sql: String,
    params: Vec<Value>,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    let q = bind_params(sqlx::query(&sql), &params);
    q.execute(&pool)
        .await
        .map_err(|e| format!("exec failed: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn default_db_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("pa.db"))
}
