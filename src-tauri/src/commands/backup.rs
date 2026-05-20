//! Backup / restore.
//!
//! Phase 1 — SQLite snapshot (`pa.db` via `VACUUM INTO`) + `manifest.json`.
//! Phase 2 — adds:
//!   - `secrets.age`         age-passphrase-encrypted JSON of vault kv pairs
//!   - `installed-pkgs.json` informational list of installed pkgs (the actual
//!                            row data already rides along inside pa.db)
//! Phase 3 — adds path_mode picker:
//!   - `raw`        absolute paths preserved (default — same-machine recovery)
//!   - `tokenized`  rewrite `$HOME/...` → `${IKENGA_HOME}/...` in 8 explicit
//!                  path columns; reversed at boot against the new user's
//!                  $HOME. Paths outside $HOME are left raw and recorded in
//!                  `path_warnings` for the UI to surface.
//!   - `bundled`    not yet implemented (returns an error if requested).
//!
//! Pkg restore stays list-only (the user re-installs from registry by hand).
//!
//! ## Restore is stage-and-swap-on-boot, not live
//!
//! `backup_import` validates the bundle and writes:
//!
//! ```text
//! <app_data_dir>/staged-restore/pa.db.new
//! <app_data_dir>/staged-restore/secrets-pending.json   (only if has_secrets and passphrase ok)
//! <app_data_dir>/staged-restore/RESTORE_PENDING        (last write — atomic-ish marker)
//! ```
//!
//! `lib.rs::setup()` calls `apply_staged_restore_if_present` BEFORE any pool
//! opens. SQLite is swapped in-place; secrets-pending.json is left for the
//! Stronghold-backed apply that runs once setup wires `SecretsLock` (the
//! lazy-open inside `bulk_set` handles initialization). On restart-after-
//! restart the file is gone, so the apply is single-shot.
//!
//! ## Why decrypt at import-time, write plaintext to staged-restore
//!
//! Two options for moving secrets across the boot boundary:
//!   (a) carry the encrypted blob through, decrypt on next boot — but we'd
//!       need to persist the passphrase, and persisting passphrases is
//!       exactly what we were trying to avoid by using age in the first
//!       place.
//!   (b) decrypt during `backup_import`, drop a chmod-0600 plaintext JSON
//!       in the user's app-data dir, apply on next boot. Window of exposure
//!       is one app launch; file is on the user's own machine.
//!
//! We pick (b). The marker is the last write so a crash mid-import never
//! leaves a half-applied state.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::secrets::{self, SecretsLock};

const BACKUP_FORMAT_VERSION: u32 = 3;
const BACKUP_SCHEMA_VERSION: i64 = 7;

const MARKER_NAME: &str = "RESTORE_PENDING";
const STAGED_DIR: &str = "staged-restore";
const STAGED_DB_NAME: &str = "pa.db.new";
const STAGED_SECRETS_NAME: &str = "secrets-pending.json";
const STAGED_PATH_REWRITE_NAME: &str = "path-rewrite.json";
const DB_NAME: &str = "pa.db";

/// `${IKENGA_HOME}` is the export-time placeholder for the originating
/// machine's `$HOME`. The tokenized export rewrites `$HOME/...` paths to
/// this prefix; the boot-time reverse-apply rewrites it back to whatever
/// `$HOME` resolves to on the restoring machine.
const HOME_TOKEN: &str = "${IKENGA_HOME}";

/// Path-bearing columns that get rewritten in tokenized mode. The optional
/// `where_clause` filters rows (used for `pkg_permissions_granted` where
/// only fs.* scopes are paths). Tables that don't exist on older snapshots
/// are tolerated — the UPDATE just no-ops.
struct PathColumn {
    table: &'static str,
    column: &'static str,
    where_clause: Option<&'static str>,
}

const PATH_COLUMNS: &[PathColumn] = &[
    PathColumn {
        table: "chat_sessions",
        column: "cwd",
        where_clause: None,
    },
    PathColumn {
        table: "chat_sessions",
        column: "project_dir",
        where_clause: None,
    },
    PathColumn {
        table: "viewer_recents",
        column: "path",
        where_clause: None,
    },
    PathColumn {
        table: "render_jobs",
        column: "output_path",
        where_clause: None,
    },
    PathColumn {
        table: "storyboards",
        column: "r1_still_path",
        where_clause: None,
    },
    PathColumn {
        table: "storyboards",
        column: "r2_still_path",
        where_clause: None,
    },
    PathColumn {
        table: "pkg_installed",
        column: "install_path",
        where_clause: None,
    },
    PathColumn {
        table: "pkg_permissions_granted",
        column: "scope_value",
        where_clause: Some("scope_kind IN ('fs.read', 'fs.write')"),
    },
];

// ─── manifest + result types ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PkgEntry {
    pub id: String,
    pub version: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PathMode {
    Raw,
    Tokenized,
    Bundled,
}

impl Default for PathMode {
    fn default() -> Self {
        PathMode::Raw
    }
}

/// Recorded for any path that couldn't be tokenized (lives outside `$HOME`).
/// The UI surfaces these so users know the restore target may not see those
/// files. We don't fail the export over them — the user already chose
/// tokenized knowing same-machine recovery still works.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathWarning {
    pub table: String,
    pub column: String,
    pub value: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format_version: u32,
    pub schema_version: i64,
    pub created_at: String,
    pub hostname: String,
    pub username: String,
    pub path_mode: PathMode,
    pub home_dir: Option<String>, // export-time $HOME, present iff path_mode == tokenized
    pub has_secrets: bool,
    pub pkg_count: u32,
    #[serde(default)]
    pub path_warnings: Vec<PathWarning>,
}

impl BackupManifest {
    fn new(
        path_mode: PathMode,
        home_dir: Option<String>,
        has_secrets: bool,
        pkg_count: u32,
        path_warnings: Vec<PathWarning>,
    ) -> Self {
        Self {
            format_version: BACKUP_FORMAT_VERSION,
            schema_version: BACKUP_SCHEMA_VERSION,
            created_at: now_iso(),
            hostname: hostname_or_unknown(),
            username: std::env::var("USER").unwrap_or_else(|_| "unknown".into()),
            path_mode,
            home_dir,
            has_secrets,
            pkg_count,
            path_warnings,
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
    pub pkg_count: u32,
    pub path_mode: PathMode,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub size_bytes: u64,
    pub secrets_count: u32,
    pub pkg_count: u32,
    pub path_warnings_count: u32,
}

#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub manifest: BackupManifest,
    pub size_bytes: u64,
    pub schema_action: SchemaAction,
    pub pkgs: Vec<PkgEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SchemaAction {
    Match,
    Forward { from: i64, to: i64 },
    NewerThanApp { backup: i64, app: i64 },
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub staged_at: String,
    pub requires_restart: bool,
    pub secrets_staged: bool,
}

// ─── public commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn backup_export<R: tauri::Runtime>(
    app: AppHandle<R>,
    lock: State<'_, SecretsLock>,
    dest_path: String,
    include_secrets: bool,
    passphrase: Option<String>,
    path_mode: Option<PathMode>,
) -> Result<ExportResult, String> {
    let path_mode = path_mode.unwrap_or_default();
    if path_mode == PathMode::Bundled {
        return Err(
            "bundled path mode is not yet implemented (phase 4). Use raw or tokenized.".into(),
        );
    }
    if include_secrets && passphrase.as_deref().unwrap_or("").is_empty() {
        return Err("a passphrase is required to include secrets".into());
    }

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

    // SQLite snapshot via VACUUM INTO — the only safe way to copy a live db.
    let snapshot = data_dir.join(format!("{DB_NAME}.export.tmp"));
    if snapshot.exists() {
        let _ = fs::remove_file(&snapshot);
    }
    vacuum_into(&db_path, &snapshot).await?;

    // Read installed pkgs from the freshly snapshotted db so the json matches
    // exactly what's inside app.db (no torn read against the live pool).
    let pkgs = read_installed_pkgs(&snapshot).await.unwrap_or_else(|e| {
        log::warn!("read_installed_pkgs failed (continuing): {e}");
        Vec::new()
    });

    // Tokenize paths in the snapshot, in place. Done after pkg-list read so
    // the json reflects original install_path values (the rewritten ones go
    // into the bundled pa.db). Warnings are appended to the manifest.
    let home_dir_str = current_home_dir();
    let (export_home, warnings) = match path_mode {
        PathMode::Raw => (None, Vec::new()),
        PathMode::Tokenized => {
            let home = home_dir_str
                .clone()
                .ok_or("tokenized path mode requires $HOME to be set")?;
            let warnings = tokenize_snapshot_paths(&snapshot, &home).await?;
            (Some(home), warnings)
        }
        PathMode::Bundled => unreachable!(),
    };

    // Optional secrets: enumerate, JSON-encode, age-encrypt with passphrase.
    let mut secrets_blob: Option<Vec<u8>> = None;
    let mut secrets_count: u32 = 0;
    if include_secrets {
        let kvs = secrets::dump_all_kvs(&app, &lock)?;
        secrets_count = kvs.len() as u32;
        let plaintext = serde_json::to_vec(&serde_json::json!({ "kvs": kvs }))
            .map_err(|e| format!("serialize secrets: {e}"))?;
        let pp = passphrase.clone().unwrap_or_default();
        secrets_blob = Some(age_encrypt(&plaintext, &pp)?);
    }

    let warnings_count = warnings.len() as u32;
    let manifest = BackupManifest::new(
        path_mode,
        export_home,
        secrets_blob.is_some(),
        pkgs.len() as u32,
        warnings,
    );
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    let pkgs_json = serde_json::to_vec_pretty(&pkgs).map_err(|e| format!("serialize pkgs: {e}"))?;

    // Build the zip.
    let file = fs::File::create(&dest).map_err(|e| format!("create dest: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts_deflate: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let opts_stored: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("manifest.json", opts_deflate)
        .map_err(|e| format!("zip start manifest: {e}"))?;
    zip.write_all(&manifest_json)
        .map_err(|e| format!("zip write manifest: {e}"))?;

    zip.start_file("app.db", opts_stored)
        .map_err(|e| format!("zip start app.db: {e}"))?;
    let db_bytes = fs::read(&snapshot).map_err(|e| format!("read snapshot: {e}"))?;
    zip.write_all(&db_bytes)
        .map_err(|e| format!("zip write app.db: {e}"))?;

    zip.start_file("installed-pkgs.json", opts_deflate)
        .map_err(|e| format!("zip start pkgs: {e}"))?;
    zip.write_all(&pkgs_json)
        .map_err(|e| format!("zip write pkgs: {e}"))?;

    if let Some(blob) = secrets_blob.as_ref() {
        zip.start_file("secrets.age", opts_stored)
            .map_err(|e| format!("zip start secrets: {e}"))?;
        zip.write_all(blob)
            .map_err(|e| format!("zip write secrets: {e}"))?;
    }

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    let _ = fs::remove_file(&snapshot);

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult {
        path: dest.to_string_lossy().into_owned(),
        size_bytes: size,
        secrets_count,
        pkg_count: pkgs.len() as u32,
        path_warnings_count: warnings_count,
    })
}

#[tauri::command]
pub async fn backup_import<R: tauri::Runtime>(
    app: AppHandle<R>,
    src_path: String,
    dry_run: bool,
    passphrase: Option<String>,
) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("no such file: {}", src.display()));
    }
    let size = fs::metadata(&src).map(|m| m.len()).unwrap_or(0);

    let manifest = read_manifest(&src)?;
    if manifest.format_version > BACKUP_FORMAT_VERSION {
        return Err(format!(
            "unsupported backup format_version {} (this app supports up to {})",
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

    let pkgs = read_pkgs_from_zip(&src).unwrap_or_default();

    if dry_run {
        let preview = ImportPreview {
            manifest,
            size_bytes: size,
            schema_action,
            pkgs,
        };
        return Ok(serde_json::to_value(preview).unwrap());
    }

    if let SchemaAction::NewerThanApp { backup, app } = &schema_action {
        return Err(format!(
            "backup schema {} is newer than running app schema {} — upgrade the app first",
            backup, app
        ));
    }

    // Stage pa.db.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let staged_dir = data_dir.join(STAGED_DIR);
    fs::create_dir_all(&staged_dir).map_err(|e| format!("mkdir staged: {e}"))?;
    let staged_db = staged_dir.join(STAGED_DB_NAME);
    extract_app_db(&src, &staged_db)?;

    // Stage path-rewrite plan if the bundle is tokenized. We can't apply it
    // pre-pool (requires async sqlx) so leave a tiny json next to pa.db.new
    // and let `apply_staged_path_rewrites` finish the job after the pool is
    // up. If we can't resolve the current $HOME we refuse the restore — a
    // tokenized bundle is unusable without a target home.
    if matches!(manifest.path_mode, PathMode::Tokenized) {
        let target_home = current_home_dir().ok_or(
            "this bundle is tokenized but $HOME is not set on the running app — \
             cannot determine where to restore paths to",
        )?;
        let rewrite = serde_json::json!({
            "from_token": HOME_TOKEN,
            "to_home": target_home,
        });
        fs::write(
            staged_dir.join(STAGED_PATH_REWRITE_NAME),
            serde_json::to_vec_pretty(&rewrite).unwrap(),
        )
        .map_err(|e| format!("write path-rewrite plan: {e}"))?;
    }

    // Stage secrets if present + passphrase ok.
    let mut secrets_staged = false;
    if manifest.has_secrets {
        let pp = passphrase.unwrap_or_default();
        if pp.is_empty() {
            // Don't fail the whole restore — let the user re-run with a
            // passphrase if they want secrets back.
            log::warn!("backup has secrets but no passphrase provided — skipping");
        } else {
            let cipher = read_zip_bytes(&src, "secrets.age")
                .map_err(|e| format!("read secrets.age: {e}"))?;
            let plaintext = age_decrypt(&cipher, &pp)
                .map_err(|e| format!("decrypt secrets (wrong passphrase?): {e}"))?;
            // Validate JSON shape before writing to disk.
            let _: serde_json::Value = serde_json::from_slice(&plaintext)
                .map_err(|e| format!("parse decrypted secrets: {e}"))?;
            let staged_secrets = staged_dir.join(STAGED_SECRETS_NAME);
            write_chmod_600(&staged_secrets, &plaintext)?;
            secrets_staged = true;
        }
    }

    // Marker is the last write — boot keys off its presence.
    let marker = staged_dir.join(MARKER_NAME);
    fs::write(&marker, marker_payload(&manifest, &src)?)
        .map_err(|e| format!("write marker: {e}"))?;

    Ok(serde_json::to_value(ImportResult {
        staged_at: staged_db.to_string_lossy().into_owned(),
        requires_restart: true,
        secrets_staged,
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
                pkg_count: m.pkg_count,
                path_mode: m.path_mode,
            }),
            Err(_) => out.push(BackupSummary {
                path: path.to_string_lossy().into_owned(),
                created_at: String::new(),
                size_bytes: size,
                schema_version: 0,
                has_secrets: false,
                pkg_count: 0,
                path_mode: PathMode::Raw,
            }),
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
    let target = PathBuf::from(&path);
    let allowed = local_backups_dir(&app)?;
    let canon_target = fs::canonicalize(&target).map_err(|e| format!("canon target: {e}"))?;
    let canon_allowed = fs::canonicalize(&allowed).map_err(|e| format!("canon allowed: {e}"))?;
    if !canon_target.starts_with(&canon_allowed) {
        return Err(format!(
            "refusing to delete file outside backups dir: {}",
            target.display()
        ));
    }
    fs::remove_file(&canon_target).map_err(|e| format!("delete: {e}"))
}

// ─── boot-time apply (called from lib.rs setup) ───────────────────────────────

/// Pre-pool stage: swap pa.db if a staged restore is present. Called BEFORE
/// any SQLite pool opens. Returns Ok(true) if applied this boot. The
/// secrets-pending.json (if any) is left in place; `apply_staged_secrets`
/// finishes that part once `SecretsLock` is registered.
pub fn apply_staged_restore_if_present(data_dir: &Path) -> Result<bool, String> {
    let staged_dir = data_dir.join(STAGED_DIR);
    let marker = staged_dir.join(MARKER_NAME);
    if !marker.exists() {
        return Ok(false);
    }
    let staged_db = staged_dir.join(STAGED_DB_NAME);
    if !staged_db.exists() {
        let _ = fs::remove_file(&marker);
        return Err("RESTORE_PENDING marker present but pa.db.new missing — cleared".into());
    }
    let live_db = data_dir.join(DB_NAME);
    for ext in ["-wal", "-shm", "-journal"] {
        let aux = data_dir.join(format!("{DB_NAME}{ext}"));
        let _ = fs::remove_file(&aux);
    }
    fs::rename(&staged_db, &live_db).map_err(|e| format!("swap pa.db: {e}"))?;
    // Marker stays until ALL deferred apply steps complete (secrets +
    // path rewrites). Each post-step removes its own staging file and
    // checks if the marker should be cleared. With nothing else staged,
    // clear it now.
    let secrets_pending = staged_dir.join(STAGED_SECRETS_NAME).exists();
    let rewrite_pending = staged_dir.join(STAGED_PATH_REWRITE_NAME).exists();
    if !secrets_pending && !rewrite_pending {
        let _ = fs::remove_file(&marker);
    }
    log::info!("[backup] swapped pa.db ← {}", live_db.display());
    Ok(true)
}

/// Post-Stronghold stage: if a `secrets-pending.json` is staged, replay it
/// into the vault then delete both it and the marker. Idempotent — safe to
/// call on every boot. Errors are surfaced to the log; we never fail boot
/// over a botched secrets restore.
pub fn apply_staged_secrets<R: tauri::Runtime>(app: &AppHandle<R>) {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("[backup] app_data_dir for staged secrets: {e}");
            return;
        }
    };
    let staged_dir = data_dir.join(STAGED_DIR);
    let secrets_file = staged_dir.join(STAGED_SECRETS_NAME);
    if !secrets_file.exists() {
        return;
    }
    let lock: State<'_, SecretsLock> = match app.try_state::<SecretsLock>() {
        Some(s) => s,
        None => {
            log::error!("[backup] SecretsLock missing during staged-secrets apply");
            return;
        }
    };
    match load_pending_kvs(&secrets_file) {
        Ok(kvs) => match secrets::bulk_set(app, &lock, &kvs) {
            Ok(n) => {
                log::info!("[backup] restored {n} secrets from staged file");
                let _ = fs::remove_file(&secrets_file);
                let _ = fs::remove_file(staged_dir.join(MARKER_NAME));
            }
            Err(e) => log::error!("[backup] bulk_set failed: {e}"),
        },
        Err(e) => log::error!("[backup] load staged secrets: {e}"),
    }
}

// ─── path tokenize / detokenize ──────────────────────────────────────────────

/// Walk `PATH_COLUMNS` in the snapshot, rewriting `<home>/...` → `${IKENGA_HOME}/...`
/// in place. Returns a list of `PathWarning`s for paths outside `<home>`
/// (left untouched). `home` is canonical (no trailing slash).
async fn tokenize_snapshot_paths(snapshot: &Path, home: &str) -> Result<Vec<PathWarning>, String> {
    let home = home.trim_end_matches('/').to_string();
    let url = format!("sqlite://{}?mode=rwc", snapshot.display());
    let pool = sqlx::SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("open snapshot for tokenize: {e}"))?;

    let mut warnings = Vec::new();
    for col in PATH_COLUMNS {
        let where_filter = col.where_clause.unwrap_or("1=1");
        // Find candidates: non-null, non-empty values that don't already
        // start with the token (idempotent in case a tokenized snapshot is
        // re-tokenized by mistake).
        let select_sql = format!(
            "SELECT rowid, \"{c}\" FROM \"{t}\" \
             WHERE \"{c}\" IS NOT NULL AND \"{c}\" <> '' \
             AND substr(\"{c}\", 1, {n}) != ? AND ({w})",
            c = col.column,
            t = col.table,
            n = HOME_TOKEN.len(),
            w = where_filter,
        );
        let rows: Result<Vec<(i64, String)>, _> = sqlx::query_as(&select_sql)
            .bind(HOME_TOKEN)
            .fetch_all(&pool)
            .await;
        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                // Table missing on older snapshots — skip silently.
                let m = e.to_string();
                if m.contains("no such table") {
                    log::debug!("tokenize: skipping missing table {}", col.table);
                    continue;
                }
                pool.close().await;
                return Err(format!("tokenize select {}.{}: {e}", col.table, col.column));
            }
        };

        for (rowid, value) in rows {
            if let Some(rest) = strip_home_prefix(&value, &home) {
                let new_value = format!("{HOME_TOKEN}{rest}");
                let upd_sql = format!(
                    "UPDATE \"{t}\" SET \"{c}\" = ? WHERE rowid = ?",
                    t = col.table,
                    c = col.column,
                );
                sqlx::query(&upd_sql)
                    .bind(&new_value)
                    .bind(rowid)
                    .execute(&pool)
                    .await
                    .map_err(|e| {
                        format!(
                            "tokenize update {}.{} rowid={rowid}: {e}",
                            col.table, col.column
                        )
                    })?;
            } else {
                warnings.push(PathWarning {
                    table: col.table.into(),
                    column: col.column.into(),
                    value,
                    reason: "outside $HOME".into(),
                });
            }
        }
    }
    pool.close().await;
    Ok(warnings)
}

/// Apply a staged path-rewrite plan against the live `pa.db`. Called from
/// setup AFTER `apply_staged_restore_if_present`, AFTER the PaDb pool is
/// available. Spins up a small async runtime via tauri's runtime helper.
/// Idempotent — once the file is consumed it's deleted, and the rewrite
/// itself is a no-op on already-rewritten values.
pub fn apply_staged_path_rewrites<R: tauri::Runtime>(app: &AppHandle<R>) {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("[backup] app_data_dir for path rewrite: {e}");
            return;
        }
    };
    let staged_dir = data_dir.join(STAGED_DIR);
    let plan_path = staged_dir.join(STAGED_PATH_REWRITE_NAME);
    if !plan_path.exists() {
        return;
    }
    let plan: serde_json::Value = match fs::read(&plan_path).map(|b| serde_json::from_slice(&b)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            log::error!("[backup] parse path-rewrite plan: {e}");
            let _ = fs::remove_file(&plan_path);
            return;
        }
        Err(e) => {
            log::error!("[backup] read path-rewrite plan: {e}");
            return;
        }
    };
    let from_token = plan
        .get("from_token")
        .and_then(|v| v.as_str())
        .unwrap_or(HOME_TOKEN)
        .to_string();
    let to_home = match plan.get("to_home").and_then(|v| v.as_str()) {
        Some(s) => s.trim_end_matches('/').to_string(),
        None => {
            log::error!("[backup] path-rewrite plan missing to_home");
            return;
        }
    };

    let live_db = data_dir.join(DB_NAME);
    let from_token_log = from_token.clone();
    let to_home_log = to_home.clone();
    let result: Result<usize, String> = tauri::async_runtime::block_on(async move {
        let url = format!("sqlite://{}?mode=rwc", live_db.display());
        let pool = sqlx::SqlitePool::connect(&url)
            .await
            .map_err(|e| format!("open live db: {e}"))?;
        let mut total: usize = 0;
        for col in PATH_COLUMNS {
            let where_filter = col.where_clause.unwrap_or("1=1");
            // REPLACE only at the start of the string, since SQLite's REPLACE
            // is global — guard with a substr prefix match.
            let upd_sql = format!(
                "UPDATE \"{t}\" SET \"{c}\" = ? || substr(\"{c}\", {n}) \
                 WHERE substr(\"{c}\", 1, {n}-1) = ? AND ({w})",
                t = col.table,
                c = col.column,
                n = from_token.len() + 1,
                w = where_filter,
            );
            match sqlx::query(&upd_sql)
                .bind(&to_home)
                .bind(&from_token)
                .execute(&pool)
                .await
            {
                Ok(r) => total += r.rows_affected() as usize,
                Err(e) => {
                    let m = e.to_string();
                    if !m.contains("no such table") {
                        log::warn!("path rewrite {}.{}: {e}", col.table, col.column);
                    }
                }
            }
        }
        pool.close().await;
        Ok(total)
    });
    match result {
        Ok(n) => {
            log::info!("[backup] rewrote {n} path-bearing rows ({from_token_log} → {to_home_log})");
            let _ = fs::remove_file(&plan_path);
            let _ = fs::remove_file(staged_dir.join(MARKER_NAME));
        }
        Err(e) => log::error!("[backup] path rewrite failed: {e}"),
    }
}

fn strip_home_prefix<'a>(value: &'a str, home: &str) -> Option<&'a str> {
    let bytes = value.as_bytes();
    let hb = home.as_bytes();
    if bytes.len() < hb.len() || &bytes[..hb.len()] != hb {
        return None;
    }
    // Match `home` itself, or `home/...` — not `home_other_dir`.
    match bytes.get(hb.len()) {
        None => Some(""),
        Some(&b'/') => Some(&value[hb.len()..]),
        _ => None,
    }
}

fn current_home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|s| !s.is_empty())
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async fn vacuum_into(src: &Path, dest: &Path) -> Result<(), String> {
    let url = format!("sqlite://{}?mode=ro", src.display());
    let pool = sqlx::SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("open source db: {e}"))?;
    let stmt = format!(
        "VACUUM INTO '{}'",
        dest.display().to_string().replace('\'', "''")
    );
    sqlx::query(&stmt)
        .execute(&pool)
        .await
        .map_err(|e| format!("VACUUM INTO failed: {e}"))?;
    pool.close().await;
    Ok(())
}

async fn read_installed_pkgs(db_path: &Path) -> Result<Vec<PkgEntry>, String> {
    let url = format!("sqlite://{}?mode=ro", db_path.display());
    let pool = sqlx::SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("open snapshot: {e}"))?;
    // Tolerate missing table (older db that hasn't run 0007 yet).
    let rows: Result<Vec<(String, String, i64)>, _> =
        sqlx::query_as("SELECT id, version, enabled FROM pkg_installed ORDER BY id")
            .fetch_all(&pool)
            .await;
    pool.close().await;
    match rows {
        Ok(rows) => Ok(rows
            .into_iter()
            .map(|(id, version, enabled)| PkgEntry {
                id,
                version,
                enabled: enabled != 0,
            })
            .collect()),
        Err(e) => {
            log::warn!("pkg_installed query failed: {e}");
            Ok(Vec::new())
        }
    }
}

fn read_manifest(zip_path: &Path) -> Result<BackupManifest, String> {
    let bytes = read_zip_bytes(zip_path, "manifest.json")?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))
}

fn read_pkgs_from_zip(zip_path: &Path) -> Result<Vec<PkgEntry>, String> {
    match read_zip_bytes(zip_path, "installed-pkgs.json") {
        Ok(bytes) => {
            serde_json::from_slice::<Vec<PkgEntry>>(&bytes).map_err(|e| format!("parse pkgs: {e}"))
        }
        Err(_) => Ok(Vec::new()), // tolerate older bundles without the file
    }
}

fn read_zip_bytes(zip_path: &Path, name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = archive.by_name(name).map_err(|e| format!("{name}: {e}"))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {name}: {e}"))?;
    Ok(buf)
}

fn extract_app_db(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let bytes = read_zip_bytes(zip_path, "app.db")?;
    if dest.exists() {
        let _ = fs::remove_file(dest);
    }
    fs::write(dest, &bytes).map_err(|e| format!("write staged db: {e}"))
}

fn marker_payload(m: &BackupManifest, src: &Path) -> Result<Vec<u8>, String> {
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

fn load_pending_kvs(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let raw = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let v: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| format!("parse staged secrets: {e}"))?;
    let kvs = v
        .get("kvs")
        .and_then(|x| x.as_object())
        .ok_or("staged secrets json missing `kvs` object")?;
    let mut out = BTreeMap::new();
    for (k, v) in kvs.iter() {
        if let Some(s) = v.as_str() {
            out.insert(k.clone(), s.to_string());
        }
    }
    Ok(out)
}

fn write_chmod_600(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir staged parent: {e}"))?;
    }
    fs::write(path, bytes).map_err(|e| format!("write staged secrets: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod staged secrets: {e}"))?;
    }
    Ok(())
}

// ─── age passphrase encryption ────────────────────────────────────────────────

fn age_encrypt(plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    use age::secrecy::SecretString;
    use std::io::Write as _;

    let encryptor =
        age::Encryptor::with_user_passphrase(SecretString::from(passphrase.to_string()));
    let mut out = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| format!("age wrap: {e}"))?;
    writer
        .write_all(plaintext)
        .map_err(|e| format!("age write: {e}"))?;
    writer.finish().map_err(|e| format!("age finish: {e}"))?;
    Ok(out)
}

fn age_decrypt(ciphertext: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    use age::secrecy::SecretString;
    use std::io::Read as _;

    let decryptor = match age::Decryptor::new(ciphertext).map_err(|e| format!("age open: {e}"))? {
        age::Decryptor::Passphrase(d) => d,
        age::Decryptor::Recipients(_) => {
            return Err("backup is not passphrase-encrypted".into());
        }
    };
    let mut reader = decryptor
        .decrypt(&SecretString::from(passphrase.to_string()), None)
        .map_err(|e| format!("age decrypt: {e}"))?;
    let mut out = Vec::new();
    reader
        .read_to_end(&mut out)
        .map_err(|e| format!("age read: {e}"))?;
    Ok(out)
}
