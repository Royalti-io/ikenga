//! Tauri commands for the pkg content server.
//!
//! Two entry points:
//!
//! - `pkg_content_html(pkgId, source)` — preferred. Returns the HTML body
//!   (with `<base href>` injected) so the frontend can `srcdoc=` it into the
//!   iframe. This is the workaround for the documented Linux/WebKitGTK bug
//!   where iframe-document loads from any non-https origin (custom protocol
//!   *or* http loopback) get blocked even though subresource fetches succeed
//!   — see https://github.com/tauri-apps/tauri/issues/12767. Loading the
//!   iframe document via `srcdoc` causes it to inherit the parent origin so
//!   the bug doesn't fire; subresources still come from
//!   `http://127.0.0.1:<port>/<pkgId>/<token>/...` via the existing axum
//!   server, which works fine on every platform.
//!
//! - `pkg_content_url(pkgId)` — legacy. Mints a token and returns the URL
//!   without reading any file. Useful for tests that want to assert the
//!   server is alive or for future call sites that need direct asset URLs.
//!
//! `pkg_content_revoke(token)` releases a token when the iframe unmounts.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::secrets::{read_secret_scoped, Scope, SecretsLock};
use crate::pkg_content::PkgContentServer;

pub struct PkgContentState(pub Arc<PkgContentServer>);

#[derive(Serialize)]
pub struct PkgContentHandle {
    /// Fully-qualified URL ending in `/`. Append `<source>` (e.g. `index.html`)
    /// to get the iframe `src`.
    pub url: String,
    /// Per-iframe token. Pass back to `pkg_content_revoke` on unmount.
    pub token: String,
}

#[tauri::command]
pub fn pkg_content_url(
    server: State<'_, PkgContentState>,
    pkg_id: String,
) -> Result<PkgContentHandle, String> {
    let h = server.0.mint(&pkg_id).map_err(|e| format!("{e:#}"))?;
    Ok(PkgContentHandle {
        url: h.url,
        token: h.token,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseHostConfig {
    pub url: String,
    pub anon_key: String,
}

/// Resolved SQLite host context threaded to pkgs that declared
/// `capabilities.sqlite` (ikenga_api ≥ 2). Exposes only the logical DB name
/// — actual queries go through the `db_query` Tauri command, not a client
/// library credential, so there is nothing secret to protect here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteHostConfig {
    /// Logical DB name — currently always `"ikenga.local"` for the local
    /// `pa.db` store. Future: additional named stores may be added.
    pub db: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgContentHtmlHandle {
    /// HTML body with `<base href>` injected — assign to `<iframe srcdoc>`.
    pub html: String,
    /// Subresource base URL — exposed for diagnostics.
    pub base_url: String,
    /// Per-iframe token; pass back to `pkg_content_revoke` on unmount.
    pub token: String,
    /// Resolved Supabase config when the pkg declared
    /// `capabilities.supabase`. `None` if the pkg didn't declare it, or
    /// declared it as non-required and the vault is missing keys.
    pub supabase: Option<SupabaseHostConfig>,
    /// Resolved SQLite config when the pkg declared `capabilities.sqlite`.
    /// `None` if the pkg didn't declare the capability.
    pub sqlite: Option<SqliteHostConfig>,
}

#[tauri::command]
pub async fn pkg_content_html(
    app: AppHandle,
    server: State<'_, PkgContentState>,
    secrets_lock: State<'_, SecretsLock>,
    pkg_id: String,
    source: String,
) -> Result<PkgContentHtmlHandle, String> {
    let supabase = match server.0.supabase_capability(&pkg_id) {
        None => None,
        Some(required) => {
            // Phase 7: shared Supabase keys live at Workspace scope.
            // read_secret_scoped falls through to the legacy unscoped key
            // when the scoped row is missing — so user vaults populated
            // before Phase 7 keep working.
            let url =
                read_secret_scoped(&app, &secrets_lock, &Scope::Workspace, "VITE_SUPABASE_URL")
                    .unwrap_or_else(|e| {
                        log::warn!("[pkg_content] vault read VITE_SUPABASE_URL failed: {e}");
                        None
                    });
            let anon = read_secret_scoped(
                &app,
                &secrets_lock,
                &Scope::Workspace,
                "VITE_SUPABASE_ANON_KEY",
            )
            .unwrap_or_else(|e| {
                log::warn!("[pkg_content] vault read VITE_SUPABASE_ANON_KEY failed: {e}");
                None
            });
            match (url, anon) {
                (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => Some(SupabaseHostConfig {
                    url: u,
                    anon_key: k,
                }),
                _ => {
                    if required {
                        return Err(format!(
                            "pkg `{pkg_id}` requires supabase capability but vault is missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY — open Settings → Secrets to populate them"
                        ));
                    }
                    None
                }
            }
        }
    };
    let sqlite = server
        .0
        .sqlite_capability(&pkg_id)
        .map(|db| SqliteHostConfig { db });
    let h = server
        .0
        .mint_html(&pkg_id, &source)
        .map_err(|e| format!("{e:#}"))?;
    Ok(PkgContentHtmlHandle {
        html: h.html,
        base_url: h.base_url,
        token: h.token,
        supabase,
        sqlite,
    })
}

#[tauri::command]
pub fn pkg_content_revoke(server: State<'_, PkgContentState>, token: String) -> Result<(), String> {
    server.0.revoke(&token);
    Ok(())
}
