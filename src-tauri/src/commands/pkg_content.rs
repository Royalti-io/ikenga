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
use tauri::State;

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
pub struct PkgContentHtmlHandle {
    /// HTML body with `<base href>` injected — assign to `<iframe srcdoc>`.
    pub html: String,
    /// Subresource base URL — exposed for diagnostics.
    pub base_url: String,
    /// Per-iframe token; pass back to `pkg_content_revoke` on unmount.
    pub token: String,
}

#[tauri::command]
pub fn pkg_content_html(
    server: State<'_, PkgContentState>,
    pkg_id: String,
    source: String,
) -> Result<PkgContentHtmlHandle, String> {
    let h = server
        .0
        .mint_html(&pkg_id, &source)
        .map_err(|e| format!("{e:#}"))?;
    Ok(PkgContentHtmlHandle {
        html: h.html,
        base_url: h.base_url,
        token: h.token,
    })
}

#[tauri::command]
pub fn pkg_content_revoke(
    server: State<'_, PkgContentState>,
    token: String,
) -> Result<(), String> {
    server.0.revoke(&token);
    Ok(())
}
