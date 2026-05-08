//! Secrets via the `tauri_plugin_stronghold::stronghold::Stronghold` wrapper
//! (a thin shim over `iota_stronghold`). Snapshot lives at
//! `app_data_dir/secrets.stronghold`. The vault key is bootstrapped from a
//! file at `app_data_dir/.vault-key` — see `crate::vault_key`. No password
//! prompt; no argon2.
//!
//! The `tauri-plugin-stronghold` plugin itself is intentionally NOT
//! registered in `lib.rs`. The FE never invokes plugin-direct commands; all
//! vault access goes through the `secrets_*` commands here, serialized by
//! `SecretsLock`. Registering the plugin would expose handlers that bypass
//! our lock and race on the same snapshot file (each `Stronghold` instance
//! owns its own per-instance RwLocks, so two instances on one snapshot path
//! corrupt writes via `commit_with_keyprovider`).
//!
//! Implementation notes:
//!   - We always open Stronghold with the key from the vault-key file.
//!   - All values are stored as UTF-8 bytes under a single client (`pa`).
//!   - We maintain a parallel `__manifest` entry containing a JSON array of
//!     known key names, so the UI can list keys without scanning the whole
//!     vault. `Store::keys()` is not stable across plugin versions; the
//!     manifest is portable.
//!   - The `secrets_dump_to_runtime_file` helper writes all key/value pairs
//!     to an OS-runtime file (`$XDG_RUNTIME_DIR/ikenga-actions/env-vault` or
//!     `$TMPDIR/ikenga-actions/env-vault` on macOS) so sidecar processes can
//!     read them via the existing dotenv loader. The file is chmod 0600 and
//!     cleaned up on app quit.
//!   - `read_secret` is a sync helper exposed for capability resolvers (e.g.
//!     pkg_content's Supabase capability) that need vault values during
//!     command handling without round-tripping through the public
//!     `secrets_get` Tauri command.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::vault_key;

const CLIENT_NAME: &[u8] = b"pa";
const MANIFEST_KEY: &[u8] = b"__manifest";

/// App-managed cache + serialization lock for Stronghold. The wrapped
/// `Stronghold` instance is opened lazily on first use (or eagerly during
/// `setup`) and reused across every `secrets_*` command — `load_snapshot`
/// runs once per app lifetime, `commit_with_keyprovider` runs only on writes.
///
/// `std::sync::Mutex` is correct here because all blocking work happens
/// inside `tokio::task::spawn_blocking`, never across `.await`. Two parallel
/// instances on the same snapshot file would corrupt writes (each has its
/// own per-instance RwLocks); this single cached instance + serialized
/// access is the canonical pattern.
pub struct SecretsLock(pub Arc<Mutex<Option<Stronghold>>>);

impl SecretsLock {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

impl Default for SecretsLock {
    fn default() -> Self {
        Self::new()
    }
}

fn snapshot_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("secrets.stronghold"))
}

/// Lazily open the cached Stronghold and load (or create) our client. After
/// first call the in-memory `Stronghold` is reused for the app's lifetime.
fn ensure_open<R: Runtime>(
    app: &AppHandle<R>,
    slot: &mut Option<Stronghold>,
) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    let path = snapshot_path(app)?;
    let pw = vault_key::fetch_or_create().map_err(|e| format!("vault key: {e}"))?;
    let stronghold = Stronghold::new(&path, pw).map_err(|e| format!("stronghold open: {e}"))?;
    // After `Stronghold::new` runs `load_snapshot` (if the file exists), the
    // client still needs to be brought into memory. Try `get_client` first
    // (no-op if the in-memory map already has it — shouldn't on a fresh
    // instance, but cheap), then `load_client` (snapshot → memory), and only
    // `create_client` when the snapshot has no such client at all.
    if stronghold.get_client(CLIENT_NAME).is_err()
        && stronghold.load_client(CLIENT_NAME).is_err()
    {
        stronghold
            .create_client(CLIENT_NAME)
            .map_err(|e| format!("stronghold create_client: {e}"))?;
    }
    *slot = Some(stronghold);
    Ok(())
}

/// Run a closure under the cached Stronghold. `commit` controls whether to
/// persist after the closure runs — reads pass `false`, writes pass `true`.
/// Lock-poisoning short-circuits with an error rather than panicking.
fn with_stronghold<R: Runtime, F, T>(
    app: &AppHandle<R>,
    state: &Arc<Mutex<Option<Stronghold>>>,
    commit: bool,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&Stronghold) -> Result<T, String>,
{
    let mut guard = state.lock().map_err(|e| format!("secrets lock poisoned: {e}"))?;
    ensure_open(app, &mut guard)?;
    let sh = guard.as_ref().expect("ensure_open populated the slot");
    let result = f(sh)?;
    if commit {
        if let Err(e) = sh.save() {
            log::warn!("stronghold save failed: {e}");
        }
    }
    Ok(result)
}

fn read_manifest(stronghold: &Stronghold) -> Result<BTreeSet<String>, String> {
    let client = stronghold
        .get_client(CLIENT_NAME)
        .map_err(|e| format!("get_client: {e}"))?;
    let store = client.store();
    match store.get(MANIFEST_KEY) {
        Ok(Some(bytes)) => {
            let s = String::from_utf8(bytes).map_err(|e| format!("manifest utf8: {e}"))?;
            let v: Vec<String> =
                serde_json::from_str(&s).map_err(|e| format!("manifest json: {e}"))?;
            Ok(v.into_iter().collect())
        }
        Ok(None) => Ok(BTreeSet::new()),
        Err(e) => Err(format!("manifest get: {e}")),
    }
}

fn write_manifest(stronghold: &Stronghold, keys: &BTreeSet<String>) -> Result<(), String> {
    let client = stronghold
        .get_client(CLIENT_NAME)
        .map_err(|e| format!("get_client: {e}"))?;
    let store = client.store();
    let v: Vec<&String> = keys.iter().collect();
    let json = serde_json::to_string(&v).map_err(|e| format!("manifest serialize: {e}"))?;
    store
        .insert(MANIFEST_KEY.to_vec(), json.into_bytes(), None)
        .map_err(|e| format!("manifest insert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
    key: String,
) -> Result<Option<String>, String> {
    if key.as_bytes() == MANIFEST_KEY {
        return Ok(None);
    }
    let state = lock.0.clone();
    tokio::task::spawn_blocking(move || {
        with_stronghold(&app, &state, false, |sh| {
            let client = sh
                .get_client(CLIENT_NAME)
                .map_err(|e| format!("get_client: {e}"))?;
            let store = client.store();
            match store.get(key.as_bytes()) {
                Ok(Some(bytes)) => {
                    let s = String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))?;
                    Ok(Some(s))
                }
                Ok(None) => Ok(None),
                Err(e) => Err(format!("store get: {e}")),
            }
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key.as_bytes() == MANIFEST_KEY || key.is_empty() {
        return Err("invalid key".into());
    }
    let state = lock.0.clone();
    let app_for_dump = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        with_stronghold(&app, &state, true, |sh| {
            let client = sh
                .get_client(CLIENT_NAME)
                .map_err(|e| format!("get_client: {e}"))?;
            let store = client.store();
            store
                .insert(key.as_bytes().to_vec(), value.into_bytes(), None)
                .map_err(|e| format!("store insert: {e}"))?;
            let mut manifest = read_manifest(sh)?;
            manifest.insert(key);
            write_manifest(sh, &manifest)?;
            Ok(())
        })?;
        // Re-dump on the same blocking thread so we don't bounce work back
        // through the runtime just to enter another spawn_blocking.
        let _ = dump_to_runtime_file_locked(&app_for_dump, &state);
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
    key: String,
) -> Result<(), String> {
    if key.as_bytes() == MANIFEST_KEY {
        return Err("invalid key".into());
    }
    let state = lock.0.clone();
    let app_for_dump = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        with_stronghold(&app, &state, true, |sh| {
            let client = sh
                .get_client(CLIENT_NAME)
                .map_err(|e| format!("get_client: {e}"))?;
            let store = client.store();
            store
                .delete(key.as_bytes())
                .map_err(|e| format!("store delete: {e}"))?;
            let mut manifest = read_manifest(sh)?;
            manifest.remove(&key);
            write_manifest(sh, &manifest)?;
            Ok(())
        })?;
        let _ = dump_to_runtime_file_locked(&app_for_dump, &state);
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn secrets_list_keys(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
) -> Result<Vec<String>, String> {
    let state = lock.0.clone();
    tokio::task::spawn_blocking(move || {
        with_stronghold(&app, &state, false, |sh| {
            let manifest = read_manifest(sh)?;
            Ok(manifest.into_iter().collect())
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub available: bool,
    pub keychain_backend: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn secrets_vault_status(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
) -> Result<VaultStatus, String> {
    let state = lock.0.clone();
    tokio::task::spawn_blocking(move || {
        let backend = vault_key::keychain_backend().to_string();
        match vault_key::fetch_or_create() {
            Ok(_) => {
                // Probe an actual open + manifest read so we surface
                // post-keychain-open failures (snapshot corruption, etc.) too.
                match with_stronghold(&app, &state, false, |sh| read_manifest(sh)) {
                    Ok(_) => Ok(VaultStatus {
                        available: true,
                        keychain_backend: backend,
                        error: None,
                    }),
                    Err(e) => Ok(VaultStatus {
                        available: false,
                        keychain_backend: backend,
                        error: Some(e),
                    }),
                }
            }
            Err(e) => Ok(VaultStatus {
                available: false,
                keychain_backend: backend,
                error: Some(e.to_string()),
            }),
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[derive(Debug, Deserialize)]
pub struct ImportDotenvArgs {
    pub paths: Vec<String>,
    /// Restrict to these key names. Empty = import every key found.
    pub keys: Vec<String>,
    /// If false, skip keys that already exist in the vault.
    pub overwrite: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportDotenvResult {
    pub imported: u32,
    pub skipped: u32,
    pub missing_files: Vec<String>,
}

fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        let k = trimmed[..eq].trim().to_string();
        let mut v = trimmed[eq + 1..].trim().to_string();
        if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2)
            || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2)
        {
            v = v[1..v.len() - 1].to_string();
        }
        out.push((k, v));
    }
    out
}

#[tauri::command]
pub async fn secrets_import_dotenv(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
    args: ImportDotenvArgs,
) -> Result<ImportDotenvResult, String> {
    let state = lock.0.clone();
    let app_for_dump = app.clone();
    tokio::task::spawn_blocking(move || -> Result<ImportDotenvResult, String> {
        let allow: BTreeSet<String> = args.keys.iter().cloned().collect();
        let restrict = !allow.is_empty();
        let mut imported = 0u32;
        let mut skipped = 0u32;
        let mut missing_files = Vec::new();

        let mut pairs: Vec<(String, String)> = Vec::new();
        for raw in &args.paths {
            let expanded = shellexpand::tilde(raw).into_owned();
            match std::fs::read_to_string(&expanded) {
                Ok(text) => {
                    for (k, v) in parse_dotenv(&text) {
                        if restrict && !allow.contains(&k) {
                            continue;
                        }
                        pairs.push((k, v));
                    }
                }
                Err(_) => missing_files.push(raw.clone()),
            }
        }

        with_stronghold(&app, &state, true, |sh| {
            let client = sh
                .get_client(CLIENT_NAME)
                .map_err(|e| format!("get_client: {e}"))?;
            let store = client.store();
            let mut manifest = read_manifest(sh)?;
            for (k, v) in pairs {
                if k.as_bytes() == MANIFEST_KEY || k.is_empty() {
                    continue;
                }
                if !args.overwrite && manifest.contains(&k) {
                    skipped += 1;
                    continue;
                }
                store
                    .insert(k.as_bytes().to_vec(), v.into_bytes(), None)
                    .map_err(|e| format!("store insert: {e}"))?;
                manifest.insert(k);
                imported += 1;
            }
            write_manifest(sh, &manifest)?;
            Ok(())
        })?;
        let _ = dump_to_runtime_file_locked(&app_for_dump, &state);
        Ok(ImportDotenvResult {
            imported,
            skipped,
            missing_files,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ─── Internal read helper (for capability resolvers) ────────────────────────

/// Read a single key from the vault. Used by capability resolvers (e.g.
/// pkg_content's Supabase capability) that need to consult secrets without
/// going through the public `secrets_get` Tauri command.
///
/// Synchronous: takes the `SecretsLock` directly and runs against the cached
/// Stronghold. Caller is already inside an async command but vault reads off
/// the cached instance are sub-millisecond, so blocking the runtime briefly
/// is acceptable. Wrap in `spawn_blocking` if calling on a hot path.
pub fn read_secret(
    app: &AppHandle,
    lock: &SecretsLock,
    key: &str,
) -> Result<Option<String>, String> {
    if key.as_bytes() == MANIFEST_KEY {
        return Ok(None);
    }
    with_stronghold(app, &lock.0, false, |sh| {
        let client = sh
            .get_client(CLIENT_NAME)
            .map_err(|e| format!("get_client: {e}"))?;
        let store = client.store();
        match store.get(key.as_bytes()) {
            Ok(Some(bytes)) => {
                let s = String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))?;
                Ok(Some(s))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("store get: {e}")),
        }
    })
}

// ─── Runtime env-vault file (for the actions sidecar) ────────────────────────

/// Path to the runtime env-vault file. macOS uses `$TMPDIR`, others use
/// `$XDG_RUNTIME_DIR` (with a `/tmp` fallback). chmod 600.
pub fn runtime_env_vault_path() -> PathBuf {
    let base: PathBuf = if cfg!(target_os = "macos") {
        std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    } else {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    };
    base.join("ikenga-actions").join("env-vault")
}

fn shell_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Dump every vault key/value into the runtime env-vault file using the
/// shared cached Stronghold. Called from the app startup hook (via
/// `dump_to_runtime_file`) and after every successful write inside the
/// commands here (via `dump_to_runtime_file_locked`, on the same blocking
/// thread that holds the lock).
fn dump_to_runtime_file_locked<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<Mutex<Option<Stronghold>>>,
) -> Result<PathBuf, String> {
    with_stronghold(app, state, false, |sh| {
        let manifest = read_manifest(sh)?;
        let client = sh
            .get_client(CLIENT_NAME)
            .map_err(|e| format!("get_client: {e}"))?;
        let store = client.store();

        let mut body = String::from("# Auto-generated by ikenga-desktop. Do not edit.\n");
        for k in &manifest {
            let bytes = match store.get(k.as_bytes()) {
                Ok(Some(b)) => b,
                _ => continue,
            };
            let val = match String::from_utf8(bytes) {
                Ok(v) => v,
                Err(_) => continue,
            };
            body.push_str(k);
            body.push('=');
            body.push_str(&shell_escape(&val));
            body.push('\n');
        }

        let path = runtime_env_vault_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir runtime: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        std::fs::write(&path, body).map_err(|e| format!("write runtime: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("chmod runtime: {e}"))?;
        }
        Ok(path)
    })
}

/// Public entry point used from the Tauri `setup` hook. Pulls the shared
/// cache out of app state. Setup runs synchronously before the runtime
/// starts handling commands, so this is fine to call directly without
/// `spawn_blocking`.
pub fn dump_to_runtime_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let lock: State<'_, SecretsLock> = app
        .try_state::<SecretsLock>()
        .ok_or_else(|| "SecretsLock state not registered".to_string())?;
    dump_to_runtime_file_locked(app, &lock.0)
}

/// Best-effort cleanup of the runtime env-vault file. Called from the app
/// quit hook.
pub fn cleanup_runtime_file() {
    let path = runtime_env_vault_path();
    let _ = std::fs::remove_file(path);
}
