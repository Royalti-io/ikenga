//! File-backed bootstrap for the Stronghold vault key.
//!
//! Key lives at `app_data_dir/.vault-key` (chmod 0600 on Unix). On first run
//! we generate a random 32-byte key, write it as hex, and return it. On
//! subsequent runs we read it back. Same security boundary as the previous
//! `.env.local` containing the service-role key — the file is per-user,
//! per-machine, and only readable by the user.
//!
//! We tried libsecret/gnome-keyring first (via the `keyring` crate, with
//! every native backend feature enabled to avoid the in-memory mock fallback);
//! on this Linux setup it still produced inconsistent reads across boots,
//! leading to "BadFileKey" loops where one boot would write a snapshot the
//! next boot couldn't decrypt. A flat file is deterministic — the snapshot
//! decrypt-roundtrip works as long as both files survive together, which
//! they do because they live in the same directory.

use std::path::PathBuf;

use rand::RngCore;

const FILENAME: &str = ".vault-key";
const KEY_LEN: usize = 32;

#[derive(Debug)]
pub enum VaultKeyError {
    Resolve(String),
    Io(String),
    Decode(String),
}

impl std::fmt::Display for VaultKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Resolve(msg) => write!(f, "resolve vault-key path: {msg}"),
            Self::Io(msg) => write!(f, "vault-key i/o: {msg}"),
            Self::Decode(msg) => write!(f, "decode vault-key: {msg}"),
        }
    }
}

impl std::error::Error for VaultKeyError {}

/// Resolve `app_data_dir/.vault-key` with the same platform conventions Tauri
/// uses for `app_data_dir`. Done without an `AppHandle` because this function
/// is called from contexts where we only have a path — same logic Tauri's
/// resolver runs internally.
fn vault_key_path() -> Result<PathBuf, VaultKeyError> {
    const BUNDLE_ID: &str = "app.ikenga";
    let dir: PathBuf = if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| VaultKeyError::Resolve("$HOME unset".into()))?;
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(BUNDLE_ID)
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| VaultKeyError::Resolve("%APPDATA% unset".into()))?;
        PathBuf::from(appdata).join(BUNDLE_ID)
    } else {
        // Linux + other unixes
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            PathBuf::from(xdg).join(BUNDLE_ID)
        } else {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| VaultKeyError::Resolve("$HOME unset".into()))?;
            PathBuf::from(home).join(".local/share").join(BUNDLE_ID)
        }
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| VaultKeyError::Io(format!("mkdir {}: {e}", dir.display())))?;
    Ok(dir.join(FILENAME))
}

/// Read the existing vault key from the file, or generate + write one.
/// Returns 32 bytes suitable for Stronghold.
pub fn fetch_or_create() -> Result<Vec<u8>, VaultKeyError> {
    let path = vault_key_path()?;
    if path.exists() {
        let hex_str = std::fs::read_to_string(&path)
            .map_err(|e| VaultKeyError::Io(format!("read {}: {e}", path.display())))?;
        let bytes = hex::decode(hex_str.trim()).map_err(|e| VaultKeyError::Decode(e.to_string()))?;
        if bytes.len() != KEY_LEN {
            return Err(VaultKeyError::Decode(format!(
                "wrong key length: {} (want {KEY_LEN})",
                bytes.len()
            )));
        }
        return Ok(bytes);
    }

    let mut buf = vec![0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex_str = hex::encode(&buf);

    // Atomic write via tmp + rename so a crash mid-write can't leave a
    // half-written key file that decrypt would fail on.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &hex_str)
        .map_err(|e| VaultKeyError::Io(format!("write {}: {e}", tmp.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| VaultKeyError::Io(format!("chmod {}: {e}", tmp.display())))?;
    }
    std::fs::rename(&tmp, &path)
        .map_err(|e| VaultKeyError::Io(format!("rename {}: {e}", path.display())))?;
    Ok(buf)
}

/// Friendly backend name for the Settings UI banner.
pub fn keychain_backend() -> &'static str {
    "file (~/.local/share/app.ikenga/.vault-key)"
}
