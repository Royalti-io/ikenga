//! Supabase project config: URL + anon key.
//!
//! These two values are not secret — Supabase explicitly designs the anon key
//! for client-side use, protected by RLS rather than secrecy. Stronghold is
//! not the right home for them (boot ordering: we'd need them before the vault
//! is unlocked). Instead we keep a tiny non-secret JSON manifest at
//! `app_data_dir/supabase.json`.
//!
//! The manifest is the single source of truth: missing manifest → app boots
//! into the setup wizard; present manifest → the FE reads URL + anon key,
//! pulls `SUPABASE_SERVICE_ROLE_KEY` from Stronghold, and creates the client.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

const FILENAME: &str = "supabase.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
    /// Optional: privileged service-role JWT. When present, the FE uses it
    /// as the Authorization Bearer for every Supabase call (bypasses RLS).
    /// Stored here rather than in Stronghold because the snapshot's KDF
    /// (age content) takes seconds-to-minutes per write on this machine,
    /// which deadlocks the FE save flow. Risk: this file is plain JSON, but
    /// it's chmod 0600 below and lives only in app_data_dir — same boundary
    /// as the previous `.env.local`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_role_key: Option<String>,
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join(FILENAME))
}

#[tauri::command]
pub async fn supabase_config_get(
    app: AppHandle,
) -> Result<Option<SupabaseConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let cfg: SupabaseConfig = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    Ok(Some(cfg))
}

#[tauri::command]
pub async fn supabase_config_set(
    app: AppHandle,
    url: String,
    anon_key: String,
    service_role_key: Option<String>,
) -> Result<(), String> {
    if url.trim().is_empty() || anon_key.trim().is_empty() {
        return Err("url and anon_key are required".into());
    }
    // Preserve the existing service_role_key if the caller didn't pass one,
    // so the URL/anon-key form doesn't accidentally wipe it.
    let merged_service_role = match service_role_key {
        Some(s) if !s.trim().is_empty() => Some(s),
        Some(_) => None, // explicit empty string → clear
        None => {
            // not supplied → preserve existing
            let path = config_path(&app)?;
            if path.exists() {
                std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str::<SupabaseConfig>(&t).ok())
                    .and_then(|c| c.service_role_key)
            } else {
                None
            }
        }
    };
    let cfg = SupabaseConfig {
        url,
        anon_key,
        service_role_key: merged_service_role,
    };
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| format!("serialize: {e}"))?;
    // Atomic write: temp + rename, so a crash mid-write can't corrupt.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn supabase_config_clear(app: AppHandle) -> Result<(), String> {
    let path = config_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}
