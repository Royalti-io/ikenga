//! Secrets via tauri-plugin-stronghold. Snapshot lives at
//! `app_data_dir/secrets.stronghold`. The vault key is bootstrapped from the
//! OS keychain — see `crate::vault_key`. No password prompt; no argon2.
//!
//! Implementation notes:
//!   - We always open Stronghold with the same key from the keychain. The
//!     plugin's password callback (in `lib.rs`) reads from the same source,
//!     so direct calls and plugin calls don't drift.
//!   - All values are stored as UTF-8 bytes under a single client (`pa`).
//!   - We maintain a parallel `__manifest` entry containing a JSON array of
//!     known key names, so the UI can list keys without scanning the whole
//!     vault. `Store::keys()` is not stable across plugin versions; the
//!     manifest is portable.
//!   - The `secrets_dump_to_runtime_file` helper writes all key/value pairs
//!     to an OS-runtime file (`$XDG_RUNTIME_DIR/pa-actions/env-vault` or
//!     `$TMPDIR/pa-actions/env-vault` on macOS) so sidecar processes can
//!     read them via the existing dotenv loader. The file is chmod 0600 and
//!     cleaned up on app quit.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_stronghold::stronghold::Stronghold;
use tokio::sync::Mutex;

use crate::vault_key;

const CLIENT_NAME: &[u8] = b"pa";
const MANIFEST_KEY: &[u8] = b"__manifest";

/// App-managed serialization lock for all Stronghold access. The plugin
/// caches Stronghold instances per snapshot path internally, but its actor
/// model deadlocks under concurrent commands. Holding this mutex across the
/// open + read/write + save sequence keeps everything single-threaded with
/// negligible cost (vault ops are infrequent and small).
pub struct SecretsLock(pub Arc<Mutex<()>>);

impl SecretsLock {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(())))
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

fn open_stronghold<R: Runtime>(app: &AppHandle<R>) -> Result<Stronghold, String> {
    let path = snapshot_path(app)?;
    let pw = vault_key::fetch_or_create().map_err(|e| format!("vault key: {e}"))?;
    let stronghold = Stronghold::new(&path, pw).map_err(|e| format!("stronghold open: {e}"))?;
    // Stronghold caches instances per-snapshot inside the plugin. After the
    // first successful `load_client`, subsequent calls fail with
    // "already loaded" — `get_client` is the post-load accessor. Try
    // `get_client` first (fast path), fall back to `load_client` on first
    // open of a session, fall back to `create_client` only when the snapshot
    // has no such client at all.
    if stronghold.get_client(CLIENT_NAME).is_err()
        && stronghold.load_client(CLIENT_NAME).is_err()
    {
        stronghold
            .create_client(CLIENT_NAME)
            .map_err(|e| format!("stronghold create_client: {e}"))?;
    }
    Ok(stronghold)
}

fn with_store<F, T>(app: &AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&Stronghold) -> Result<T, String>,
{
    let stronghold = open_stronghold(app)?;
    let result = f(&stronghold);
    if let Err(e) = stronghold.save() {
        log::warn!("stronghold save failed: {e}");
    }
    result
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
    let _guard = lock.0.lock().await;
    with_store(&app, |sh| {
        let client = sh
            .get_client(CLIENT_NAME)
            .map_err(|e| format!("get_client: {e}"))?;
        let store = client.store();
        let key_bytes = key.as_bytes().to_vec();
        match store.get(&key_bytes) {
            Ok(Some(bytes)) => {
                let s = String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))?;
                Ok(Some(s))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("store get: {e}")),
        }
    })
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
    let _guard = lock.0.lock().await;
    with_store(&app, |sh| {
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
    let _ = dump_to_runtime_file(&app);
    Ok(())
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
    let _guard = lock.0.lock().await;
    with_store(&app, |sh| {
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
    let _ = dump_to_runtime_file(&app);
    Ok(())
}

#[tauri::command]
pub async fn secrets_list_keys(
    app: AppHandle,
    lock: State<'_, SecretsLock>,
) -> Result<Vec<String>, String> {
    let _guard = lock.0.lock().await;
    with_store(&app, |sh| {
        let manifest = read_manifest(sh)?;
        Ok(manifest.into_iter().collect())
    })
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
    let _guard = lock.0.lock().await;
    let backend = vault_key::keychain_backend().to_string();
    match vault_key::fetch_or_create() {
        Ok(_) => {
            // Probe an actual open + manifest read so we surface
            // post-keychain-open failures (snapshot corruption, etc.) too.
            match open_stronghold(&app).and_then(|sh| read_manifest(&sh)) {
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
    let _guard = lock.0.lock().await;
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

    with_store(&app, |sh| {
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
    let _ = dump_to_runtime_file(&app);
    Ok(ImportDotenvResult {
        imported,
        skipped,
        missing_files,
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
    base.join("pa-actions").join("env-vault")
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

/// Dump every vault key/value into the runtime env-vault file. Caller is the
/// app startup hook + every secrets_set/delete/import.
pub fn dump_to_runtime_file(app: &AppHandle) -> Result<PathBuf, String> {
    let stronghold = open_stronghold(app)?;
    let manifest = read_manifest(&stronghold)?;

    let client = stronghold
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
}

/// Best-effort cleanup of the runtime env-vault file. Called from the app
/// quit hook.
pub fn cleanup_runtime_file() {
    let path = runtime_env_vault_path();
    let _ = std::fs::remove_file(path);
}
