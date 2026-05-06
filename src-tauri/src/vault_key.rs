//! OS-keychain bootstrap for the Stronghold vault key.
//!
//! On first run we generate a random 32-byte key, store it in the OS
//! keychain (libsecret on Linux, Keychain on macOS, Credential Manager on
//! Windows), and return it. On subsequent runs we read it back out. The
//! Stronghold password-hash callback ignores its input and returns this key
//! verbatim.
//!
//! No password prompt, no argon2 — phase 14 design decision (see
//! `.company/technical/plans/2026-04-30-pa-desktop-migration/14-phase-14-secrets-vault.md`).

use keyring::Entry;
use rand::RngCore;

const SERVICE: &str = "ikenga-desktop";
const ACCOUNT: &str = "vault-key-v1";
const KEY_LEN: usize = 32;

#[derive(Debug)]
pub enum VaultKeyError {
    Entry(String),
    Decode(String),
}

impl std::fmt::Display for VaultKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Entry(msg) => write!(f, "keyring entry: {msg}"),
            Self::Decode(msg) => write!(f, "decode keychain value: {msg}"),
        }
    }
}

impl std::error::Error for VaultKeyError {}

fn entry() -> Result<Entry, VaultKeyError> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| VaultKeyError::Entry(e.to_string()))
}

/// Read the existing vault key from the OS keychain, or generate + store one.
/// Returns 32 bytes suitable for Stronghold.
pub fn fetch_or_create() -> Result<Vec<u8>, VaultKeyError> {
    let e = entry()?;
    match e.get_password() {
        Ok(hex_str) => {
            let bytes =
                hex::decode(hex_str.trim()).map_err(|e| VaultKeyError::Decode(e.to_string()))?;
            if bytes.len() != KEY_LEN {
                return Err(VaultKeyError::Decode(format!(
                    "wrong key length: {} (want {KEY_LEN})",
                    bytes.len()
                )));
            }
            Ok(bytes)
        }
        Err(keyring::Error::NoEntry) => {
            let mut buf = vec![0u8; KEY_LEN];
            rand::thread_rng().fill_bytes(&mut buf);
            let hex_str = hex::encode(&buf);
            e.set_password(&hex_str)
                .map_err(|e| VaultKeyError::Entry(e.to_string()))?;
            Ok(buf)
        }
        Err(other) => Err(VaultKeyError::Entry(other.to_string())),
    }
}

/// Friendly backend name for the Settings UI banner.
pub fn keychain_backend() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "libsecret"
    }
}
