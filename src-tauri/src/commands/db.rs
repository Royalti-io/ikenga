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
use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

/// SQLite handle for the local `pa.db`.
///
/// WP-01 (G-DB-CORE): the database is opened through **two** sqlx pools rather
/// than one shared pool. SQLite is single-writer; under a single shared pool a
/// long-running read transaction can starve a pending write (and vice-versa),
/// surfacing as `SQLITE_BUSY` / "database is locked". The fix is the standard
/// pattern for embedded SQLite under concurrency:
///
/// * **`writer`** — a pool capped at `max_connections = 1`, so every write is
///   serialized through a single connection and writes never contend with each
///   other. WAL journaling + a `busy_timeout` make any momentary contention
///   wait rather than error.
/// * **`reader`** — a multi-connection pool used only for `SELECT`s. WAL lets
///   readers run concurrently with the writer without blocking it.
///
/// Both pools open the same file with identical `SqliteConnectOptions`. WAL is
/// a persistent file-level mode, so once the writer sets it the reader inherits
/// it on connect. The writer is always initialized first (it owns schema
/// migration), guaranteeing WAL is in effect before any reader connects.
///
/// `ensure_pool()` returns the **writer** pool and keeps its original
/// signature: it is correct for both reads and writes (just serialized), so the
/// ~80 existing callers across the shell that hold a `SqlitePool` for mixed
/// read/write work — including `pool.begin()` transactions — remain correct
/// without edits. Only the hot `db_query` command is routed to the dedicated
/// reader pool for read parallelism.
pub struct PaDb {
    writer: Mutex<Option<sqlx::SqlitePool>>,
    reader: Mutex<Option<sqlx::SqlitePool>>,
    db_path: PathBuf,
}

/// How long a connection waits on a locked database before returning
/// `SQLITE_BUSY`. Load-bearing: this is what turns transient writer/reader
/// contention into a short wait instead of an error.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

impl PaDb {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            writer: Mutex::new(None),
            reader: Mutex::new(None),
            db_path,
        }
    }

    pub fn db_path_for_diag(&self) -> &PathBuf {
        &self.db_path
    }

    /// Shared connect options for both pools: WAL journaling, a busy_timeout so
    /// contention waits instead of erroring, `synchronous = NORMAL` (safe under
    /// WAL, much faster than FULL), and create-if-missing so a fresh install
    /// opens cleanly.
    fn connect_options(&self) -> SqliteConnectOptions {
        SqliteConnectOptions::new()
            .filename(&self.db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(BUSY_TIMEOUT)
            .synchronous(SqliteSynchronous::Normal)
    }

    /// Return the serialized **writer** pool, lazily building it (and applying
    /// migrations) on first use. Signature is unchanged from the pre-WP-01
    /// single-pool design — every existing caller keeps working, and writes are
    /// now serialized through a single connection.
    pub async fn ensure_pool(&self) -> Result<sqlx::SqlitePool, String> {
        let mut guard = self.writer.lock().await;
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
        // Make sure parent dir + file exist so sqlx can open it.
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        // max_connections = 1: a single serialized writer. WAL is set on this
        // connection first, so it's the connection that flips the journal mode
        // for the whole file before any reader connects.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(self.connect_options())
            .await
            .map_err(|e| format!("sqlite writer connect: {e}"))?;
        // Apply migrations idempotently against the writer exactly once.
        // tauri-plugin-sql's migration runner only fires when JS calls
        // Database.load(), and that path has been observed to silently hang
        // (see raceTimeout in workspace.tsx). When it times out, pa.db stays
        // schema-less and every Rust-side query fails with "no such table".
        // Running migrations on the Rust writer makes the schema guaranteed
        // regardless of plugin behavior.
        ensure_schema(&pool).await?;
        *guard = Some(pool.clone());
        Ok(pool)
    }

    /// Return the multi-connection **reader** pool, lazily building it. Ensures
    /// the writer pool exists first so WAL is engaged and the schema is applied
    /// before any read connection opens.
    pub async fn ensure_reader_pool(&self) -> Result<sqlx::SqlitePool, String> {
        // Initialize the writer (WAL + schema) before opening readers.
        self.ensure_pool().await?;
        let mut guard = self.reader.lock().await;
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(self.connect_options())
            .await
            .map_err(|e| format!("sqlite reader connect: {e}"))?;
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
        (
            24,
            "0024_rename_chat_threads_to_chat_sessions",
            include_str!("../../migrations/0024_rename_chat_threads_to_chat_sessions.sql"),
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
        "chat_sessions",
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

    // Reads go through the dedicated multi-connection reader pool so they run
    // concurrently with the serialized writer (WP-01).
    let pool = db.ensure_reader_pool().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Open an isolated PaDb on a tempdir-backed sqlite file. Returns the db
    /// plus the TempDir guard (kept alive for the test's lifetime).
    async fn fresh_db() -> (PaDb, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = PaDb::new(tmp.path().join("pa.db"));
        (db, tmp)
    }

    /// Schema init applies every embedded migration exactly once. The
    /// `_pa_migrations` table must end with one row per migration tuple (24 as
    /// of WP-01). This guards against a migration silently being dropped from
    /// the embedded list — a class of bug we've hit before.
    #[tokio::test]
    async fn ensure_schema_applies_all_migrations() {
        let (db, _tmp) = fresh_db().await;
        let writer = db.ensure_pool().await.expect("ensure_pool");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _pa_migrations")
            .fetch_one(&writer)
            .await
            .expect("count migrations");
        assert_eq!(
            count, 24,
            "expected all 24 embedded migrations to be recorded in _pa_migrations, got {count}"
        );

        // Idempotency: a second ensure_pool() (cached) must not double-apply.
        let writer2 = db.ensure_pool().await.expect("ensure_pool cached");
        let count2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _pa_migrations")
            .fetch_one(&writer2)
            .await
            .expect("recount migrations");
        assert_eq!(count2, 24, "migration count must be stable across calls");
    }

    /// Verify WAL is actually engaged on the writer connection — this is what
    /// makes concurrent reads-during-write safe.
    #[tokio::test]
    async fn writer_uses_wal_journal() {
        let (db, _tmp) = fresh_db().await;
        let writer = db.ensure_pool().await.expect("ensure_pool");
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&writer)
            .await
            .expect("journal_mode");
        assert_eq!(mode.to_lowercase(), "wal", "expected WAL journal mode");
    }

    /// Reader-during-write smoke: hold a stream of reads on the reader pool
    /// while a sustained series of writes runs on the writer pool, and assert
    /// **no `SQLITE_BUSY` / "database is locked"** error surfaces from either
    /// side. Under a single shared pool this is the scenario that starves and
    /// errors; with the writer/reader split + WAL + busy_timeout it must not.
    #[tokio::test]
    async fn concurrent_reads_during_writes_never_lock() {
        let (db, _tmp) = fresh_db().await;
        let db = Arc::new(db);

        // Initialize both pools (writer also applies schema).
        let writer = db.ensure_pool().await.expect("ensure_pool");
        let reader = db.ensure_reader_pool().await.expect("ensure_reader_pool");

        // A scratch table to hammer.
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _wp01_smoke (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)",
        )
        .execute(&writer)
        .await
        .expect("create smoke table");

        // Writer task: 200 INSERTs, several in explicit transactions to hold
        // the write lock longer (the worst case for a starving reader).
        let writer_pool = writer.clone();
        let write_task = tokio::spawn(async move {
            for i in 0..200i64 {
                if i % 10 == 0 {
                    let mut tx = writer_pool.begin().await.map_err(|e| e.to_string())?;
                    for j in 0..5i64 {
                        sqlx::query("INSERT INTO _wp01_smoke (v) VALUES (?)")
                            .bind(i * 100 + j)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    tx.commit().await.map_err(|e| e.to_string())?;
                } else {
                    sqlx::query("INSERT INTO _wp01_smoke (v) VALUES (?)")
                        .bind(i)
                        .execute(&writer_pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok::<(), String>(())
        });

        // Reader task: continuous COUNT(*) reads concurrent with the writes.
        let reader_pool = reader.clone();
        let read_task = tokio::spawn(async move {
            for _ in 0..400 {
                let _n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _wp01_smoke")
                    .fetch_one(&reader_pool)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::task::yield_now().await;
            }
            Ok::<(), String>(())
        });

        let (w, r) = tokio::join!(write_task, read_task);
        let w = w.expect("writer task join");
        let r = r.expect("reader task join");

        // The key assertion: neither side saw a lock/busy error.
        for res in [&w, &r] {
            if let Err(e) = res {
                let low = e.to_lowercase();
                assert!(
                    !(low.contains("database is locked") || low.contains("sqlite_busy")),
                    "saw a lock/busy error under concurrent read/write: {e}"
                );
                panic!("unexpected db error under concurrency: {e}");
            }
        }

        // Sanity: all writes landed. 200 iterations: every 10th (20 of them)
        // is a 5-row transaction = 100 rows; the other 180 are single inserts.
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _wp01_smoke")
            .fetch_one(&reader)
            .await
            .expect("final count");
        assert_eq!(
            total, 280,
            "all writes should have committed (180 single + 20*5 tx)"
        );
    }
}
