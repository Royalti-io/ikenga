//! Backup / restore (Phase 1).
//!
//! Phase 1 scope: SQLite (`pa.db`) only. No secrets, no installed-pkg list,
//! raw absolute paths preserved as-is. Bundle layout:
//!
//! ```text
//! manifest.json   — versioning, schema_version, created_at, hostname
//! app.db          — VACUUM INTO snapshot of <app_data_dir>/pa.db
//! ```
//!
//! Restore is **stage-and-swap-on-boot**, not live. `backup_import` validates
//! the bundle and writes:
//!
//! ```text
//! <app_data_dir>/staged-restore/pa.db.new
//! <app_data_dir>/staged-restore/RESTORE_PENDING
//! ```
//!
//! The marker is checked by `lib.rs::setup()` before opening any DB pool —
//! if present, it atomically replaces `pa.db` and clears the marker. The
//! frontend gets a `requires_restart: true` flag and is expected to prompt.
//! Avoiding live-swap means we don't have to reach into tauri-plugin-sql's
//! private pool or coordinate shutdowns of every component holding a
//! connection (PaDb, plugin, sidecar supervisors).
//!
//! Phase 2+ extends this with secrets (age-encrypted), `installed-pkgs.json`,
//! and path mode selection.
//!
//! `BACKUP_FORMAT_VERSION` and `BACKUP_SCHEMA_VERSION_MAX` move forward
//! together with the on-disk format and the highest applied SQLite migration.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_SCHEMA_VERSION: i64 = 7;

const MARKER_NAME: &str = "RESTORE_PENDING";
const STAGED_DIR: &str = "staged-restore";
const STAGED_DB_NAME: &str = "pa.db.new";
const DB_NAME: &str = "pa.db";

// ─── manifest ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format_version: u32,
    pub schema_version: i64,
    pub created_at: String, // ISO-8601
    pub hostname: String,
    pub username: String,
    pub path_mode: String, // "raw" for phase 1
    pub has_secrets: bool, // false for phase 1
    pub pkg_count: u32,    // 0 for phase 1
}

impl BackupManifest {
    fn current() -> Self {
        Self {
            format_version: BACKUP_FORMAT_VERSION,
            schema_version: BACKUP_SCHEMA_VERSION,
            created_at: now_iso(),
            hostname: hostname_or_unknown(),
            username: std::env::var("USER").unwrap_or_else(|_| "unknown".into()),
            path_mode: "raw".into(),
            has_secrets: false,
            pkg_count: 0,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackupSummary {
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub schema_version: i64,
    pub has_secrets: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub manifest: BackupManifest,
    pub size_bytes: u64,
    pub schema_action: SchemaAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SchemaAction {
    /// Backup schema matches running app — safe to restore.
    Match,
    /// Backup schema is older — migrations will run forward on next boot.
    Forward { from: i64, to: i64 },
    /// Backup schema is newer than the running app — refuses to restore.
    NewerThanApp { backup: i64, app: i64 },
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub staged_at: String, // path to staged db
    pub requires_restart: bool,
}

// ─── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn backup_export<R: tauri::Runtime>(
    app: AppHandle<R>,
    dest_path: String,
) -> Result<ExportResult, String> {
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir dest parent: {e}"))?;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let db_path = data_dir.join(DB_NAME);
    if !db_path.exists() {
        return Err(format!("no database at {}", db_path.display()));
    }

    // VACUUM INTO a temp file. SQLite's online-backup is the only safe way to
    // copy a live db; a raw fs::copy on an open WAL-mode database can produce
    // a torn snapshot.
    let snapshot = data_dir.join(format!("{DB_NAME}.export.tmp"));
    if snapshot.exists() {
        let _ = fs::remove_file(&snapshot);
    }
    vacuum_into(&db_path, &snapshot).await?;

    // Build the zip.
    let manifest = BackupManifest::current();
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("serialize manifest: {e}"))?;

    let file = fs::File::create(&dest).map_err(|e| format!("create dest: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);

    let opts_deflate: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let opts_stored: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    zip.start_file("manifest.json", opts_deflate)
        .map_err(|e| format!("zip start manifest: {e}"))?;
    zip.write_all(&manifest_json)
        .map_err(|e| format!("zip write manifest: {e}"))?;

    zip.start_file("app.db", opts_stored)
        .map_err(|e| format!("zip start app.db: {e}"))?;
    let db_bytes = fs::read(&snapshot).map_err(|e| format!("read snapshot: {e}"))?;
    zip.write_all(&db_bytes)
        .map_err(|e| format!("zip write app.db: {e}"))?;

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    let _ = fs::remove_file(&snapshot);

    let size = fs::metadata(&dest)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(ExportResult {
        path: dest.to_string_lossy().into_owned(),
        size_bytes: size,
    })
}

#[tauri::command]
pub async fn backup_import<R: tauri::Runtime>(
    app: AppHandle<R>,
    src_path: String,
    dry_run: bool,
) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("no such file: {}", src.display()));
    }
    let size = fs::metadata(&src)
        .map(|m| m.len())
        .unwrap_or(0);

    let manifest = read_manifest(&src)?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "unsupported backup format_version {} (expected {})",
            manifest.format_version, BACKUP_FORMAT_VERSION
        ));
    }
    let schema_action = match manifest.schema_version.cmp(&BACKUP_SCHEMA_VERSION) {
        std::cmp::Ordering::Equal => SchemaAction::Match,
        std::cmp::Ordering::Less => SchemaAction::Forward {
            from: manifest.schema_version,
            to: BACKUP_SCHEMA_VERSION,
        },
        std::cmp::Ordering::Greater => SchemaAction::NewerThanApp {
            backup: manifest.schema_version,
            app: BACKUP_SCHEMA_VERSION,
        },
    };

    if dry_run {
        let preview = ImportPreview {
            manifest,
            size_bytes: size,
            schema_action,
        };
        return Ok(serde_json::to_value(preview).unwrap());
    }

    if let SchemaAction::NewerThanApp { backup, app } = &schema_action {
        return Err(format!(
            "backup schema {} is newer than running app schema {} — upgrade the app first",
            backup, app
        ));
    }

    // Stage the new db into <app_data_dir>/staged-restore/. Boot picks it up.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let staged_dir = data_dir.join(STAGED_DIR);
    fs::create_dir_all(&staged_dir).map_err(|e| format!("mkdir staged: {e}"))?;
    let staged_db = staged_dir.join(STAGED_DB_NAME);
    extract_app_db(&src, &staged_db)?;

    // Marker is the last write — boot uses its presence to decide whether to
    // swap. Any partial extract above leaves no marker, so a crash mid-import
    // leaves the running db untouched on next launch.
    let marker = staged_dir.join(MARKER_NAME);
    fs::write(&marker, manifest_marker_payload(&src)?)
        .map_err(|e| format!("write marker: {e}"))?;

    Ok(serde_json::to_value(ImportResult {
        staged_at: staged_db.to_string_lossy().into_owned(),
        requires_restart: true,
    })
    .unwrap())
}

#[tauri::command]
pub async fn backup_list<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<BackupSummary>, String> {
    let dir = local_backups_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read backups dir: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("ikbak") {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match read_manifest(&path) {
            Ok(m) => out.push(BackupSummary {
                path: path.to_string_lossy().into_owned(),
                created_at: m.created_at,
                size_bytes: size,
                schema_version: m.schema_version,
                has_secrets: m.has_secrets,
            }),
            Err(_) => {
                // Tolerate corrupt files in the listing — surface path with empty fields
                // so the UI can offer to delete it.
                out.push(BackupSummary {
                    path: path.to_string_lossy().into_owned(),
                    created_at: String::new(),
                    size_bytes: size,
                    schema_version: 0,
                    has_secrets: false,
                });
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub async fn backup_delete<R: tauri::Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), String> {
    // Only allow deletion inside the app's local-backups dir to prevent the
    // command being abused as a generic file-delete.
    let target = PathBuf::from(&path);
    let allowed = local_backups_dir(&app)?;
    let canon_target = fs::canonicalize(&target).map_err(|e| format!("canon target: {e}"))?;
    let canon_allowed =
        fs::canonicalize(&allowed).map_err(|e| format!("canon allowed: {e}"))?;
    if !canon_target.starts_with(&canon_allowed) {
        return Err(format!(
            "refusing to delete file outside backups dir: {}",
            target.display()
        ));
    }
    fs::remove_file(&canon_target).map_err(|e| format!("delete: {e}"))
}

// ─── boot-time apply (called from lib.rs setup) ───────────────────────────────

/// Called from `lib.rs::setup()` BEFORE any SQLite pool is opened. Returns
/// `Ok(true)` if a staged restore was applied this boot, `Ok(false)` if not.
pub fn apply_staged_restore_if_present(data_dir: &Path) -> Result<bool, String> {
    let staged_dir = data_dir.join(STAGED_DIR);
    let marker = staged_dir.join(MARKER_NAME);
    if !marker.exists() {
        return Ok(false);
    }
    let staged_db = staged_dir.join(STAGED_DB_NAME);
    if !staged_db.exists() {
        // Marker without staged db — clean up and continue.
        let _ = fs::remove_file(&marker);
        return Err("RESTORE_PENDING marker present but pa.db.new missing — cleared".into());
    }
    let live_db = data_dir.join(DB_NAME);
    // Drop any sidecar journal/WAL files so SQLite starts clean against the
    // restored snapshot. VACUUM INTO emits a single non-WAL file; leftover
    // -wal/-shm from the previous run would shadow it.
    for ext in ["-wal", "-shm", "-journal"] {
        let aux = data_dir.join(format!("{DB_NAME}{ext}"));
        let _ = fs::remove_file(&aux);
    }
    fs::rename(&staged_db, &live_db).map_err(|e| format!("swap pa.db: {e}"))?;
    let _ = fs::remove_file(&marker);
    log::info!("applied staged backup restore → {}", live_db.display());
    Ok(true)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async fn vacuum_into(src: &Path, dest: &Path) -> Result<(), String> {
    let url = format!("sqlite://{}?mode=ro", src.display());
    let pool = sqlx::SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("open source db: {e}"))?;
    // VACUUM INTO refuses to overwrite an existing path; we deleted it above.
    let stmt = format!("VACUUM INTO '{}'", dest.display().to_string().replace('\'', "''"));
    sqlx::query(&stmt)
        .execute(&pool)
        .await
        .map_err(|e| format!("VACUUM INTO failed: {e}"))?;
    pool.close().await;
    Ok(())
}

fn read_manifest(zip_path: &Path) -> Result<BackupManifest, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|e| format!("manifest.json: {e}"))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_slice(&buf).map_err(|e| format!("parse manifest: {e}"))
}

fn extract_app_db(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = archive
        .by_name("app.db")
        .map_err(|e| format!("app.db missing from bundle: {e}"))?;
    if dest.exists() {
        let _ = fs::remove_file(dest);
    }
    let mut out = fs::File::create(dest).map_err(|e| format!("create staged db: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract app.db: {e}"))?;
    Ok(())
}

fn manifest_marker_payload(src: &Path) -> Result<Vec<u8>, String> {
    // Tiny payload — useful for diag/log if a restore goes sideways.
    let m = read_manifest(src)?;
    let out = serde_json::json!({
        "source": src.to_string_lossy(),
        "manifest": m,
        "staged_at": now_iso(),
    });
    Ok(serde_json::to_vec_pretty(&out).unwrap())
}

fn local_backups_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?
        .join("backups");
    Ok(dir)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn hostname_or_unknown() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "unknown".into())
}
