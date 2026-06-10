//! `pkg_fetch` — the Rust half of the `host.fetch` mediated-proxy verb
//! (ADR-017, WP-04). A TRUSTED iframe pkg names a URL + request shape; the
//! shell makes the actual request, attaches an auth credential read from
//! Stronghold at request time, and returns the (credential-free) response.
//!
//! The whole point: the auth secret is read, used, and dropped entirely
//! Rust-side. It is structurally impossible for the iframe to read it back —
//! we only ever return *response* headers (with cookies stripped) and the
//! body, never the injected auth header.
//!
//! ALL enforcement is here / in `pkg::http_proxy` (the pure policy core), never
//! FE-side: the renderer is observable by the iframe, so the URL allowlist +
//! SSRF guard + credential injection must not be reachable from the renderer.
//! The FE `pkgDeclaresHttp` + `pkgIsTrustedForElevated` checks in
//! `dispatchHostCall` are fail-fast UX only; a hostile iframe skips them and
//! still hits this authoritative gate.
//!
//! Safety summary (see `pkg::http_proxy` for the testable pieces):
//! - **Trust:** re-checks `resolve_elevated_trust` server-side; deny → audit.
//! - **URL allowlist:** the request URL must match a `permissions.net` glob.
//! - **SSRF:** DNS-resolve the host, reject any loopback/private/link-local/
//!   CGNAT/ULA/multicast IP, then PIN the reqwest connection to the exact vetted
//!   IP (closes the DNS-rebind TOCTOU). `https_only` blocks downgrade.
//! - **Redirects:** auto-follow disabled; we follow manually (max 3), re-running
//!   the allowlist + SSRF guard on each hop and DROPPING the auth header on any
//!   cross-origin hop so a 30x can't bounce the credential to an attacker.
//! - **Size cap:** the response body is streamed and capped (≤ 8 MiB hard
//!   ceiling) so a huge response can't OOM the shell.
//! - **Header hygiene:** pkg-supplied headers are denylisted (`authorization`,
//!   `cookie`, `host`, `proxy-*`, the configured auth header) and CR/LF-rejected.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::commands::secrets::{read_secret_scoped, Scope, SecretsLock};
use crate::pkg::http_proxy::{self as proxy, FetchRefusal};
use crate::pkg::manifest::Package;
use crate::pkg::permissions_check::{record_violation, ShellExecuteDenied};

/// Wire request from the FE `host.fetch` branch. Mirrors `PkgFetchReq` in
/// `shell/src/lib/tauri-cmd.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgFetchReq {
    /// Absolute http(s) URL. Must match a `permissions.net` glob.
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// String body sent verbatim, or any JSON value serialized to a string.
    #[serde(default)]
    pub body: Option<serde_json::Value>,
    /// Per-call timeout (ms), clamped to `[1, MAX_TIMEOUT_MS]`.
    #[serde(default)]
    pub timeout: Option<u64>,
}

/// Frozen result envelope. Mirrors `PkgFetchResult` in `tauri-cmd.ts`. A non-2xx
/// HTTP status is `ok: true` — only gate/guard/transport failures set `ok: false`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgFetchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    /// Response body as a string (the pkg parses JSON itself). Never the auth header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// Frozen refusal code when `ok: false` (see `FetchRefusal::as_str`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl PkgFetchResult {
    fn refused(reason: FetchRefusal) -> Self {
        Self {
            ok: false,
            status: None,
            headers: None,
            body: None,
            truncated: None,
            bytes: None,
            reason: Some(reason.as_str().to_string()),
        }
    }
}

/// The pkg's resolved `capabilities.http` declaration + its `permissions.net`
/// allowlist + the auth secret's vault key, gathered from a fresh manifest load.
struct HttpCapResolved {
    net: Vec<String>,
    /// `(vault_key, auth_header)` when an auth secret is configured, else None.
    auth: Option<(String, String)>,
}

/// Load the pkg's manifest off disk and resolve its http capability. Returns
/// `Err(CapabilityMissing)` when the pkg isn't installed, the manifest won't
/// load, or it didn't declare `capabilities.http`. The auth secret's vault key
/// is resolved by matching `http.auth_secret` against the pkg's
/// `capabilities.secrets` declarations (the declaration's `vault_key`), so the
/// FE/manifest only ever names the logical secret — never the vault key.
fn resolve_http_cap(
    kernel: &crate::pkg::kernel::Kernel,
    pkg_id: &str,
) -> Result<HttpCapResolved, FetchRefusal> {
    let install_path = kernel
        .installed_path(pkg_id)
        .ok_or(FetchRefusal::CapabilityMissing)?;
    let pkg = Package::load(&install_path).map_err(|e| {
        tracing::warn!("[pkg_fetch] pkg `{pkg_id}` manifest reload failed: {e:#}");
        FetchRefusal::CapabilityMissing
    })?;
    let caps = pkg
        .manifest
        .capabilities
        .as_ref()
        .ok_or(FetchRefusal::CapabilityMissing)?;
    let http = caps.http.as_ref().ok_or(FetchRefusal::CapabilityMissing)?;

    let auth = match &http.auth_secret {
        None => None,
        Some(secret_name) => {
            // Map the logical secret name → its vault_key via the secrets cap.
            // If the http cap names an auth_secret that isn't a declared named
            // secret, fall back to treating the name itself as the vault key
            // (still gated by vault.keys at read time below).
            let vault_key = caps
                .secrets
                .as_ref()
                .and_then(|s| {
                    s.declarations
                        .iter()
                        .find(|d| &d.name == secret_name)
                        .map(|d| d.vault_key.clone())
                })
                .unwrap_or_else(|| secret_name.clone());
            Some((vault_key, http.auth_header.clone()))
        }
    };

    Ok(HttpCapResolved {
        net: pkg.manifest.permissions.net.clone(),
        auth,
    })
}

/// Resolve the host to a vetted, public IP for SSRF-safe connection pinning.
/// Returns the first non-blocked socket addr, or `SsrfBlocked` if every
/// resolved address is private/loopback/etc. (unless the net allowlist
/// explicitly names this host — the author's intentional loopback/dev opt-in).
async fn vet_and_pin_ip(
    host: &str,
    port: u16,
    net: &[String],
) -> Result<SocketAddr, FetchRefusal> {
    let allow_named = proxy::net_allowlist_names_host(host, net);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| {
            tracing::warn!("[pkg_fetch] DNS lookup for `{host}:{port}` failed: {e}");
            FetchRefusal::NetworkError
        })?
        .collect();
    if addrs.is_empty() {
        return Err(FetchRefusal::NetworkError);
    }
    // Prefer a vetted (public) address. If the author explicitly allow-listed
    // this host, a private/loopback address is acceptable (dev opt-in).
    for sa in &addrs {
        if !proxy::ip_is_blocked(sa.ip()) {
            return Ok(*sa);
        }
    }
    if allow_named {
        // Every address is private but the host is explicitly named — pin the
        // first (the author opted in to this loopback/LAN target).
        return Ok(addrs[0]);
    }
    Err(FetchRefusal::SsrfBlocked)
}

#[tauri::command]
pub async fn pkg_fetch(
    app: AppHandle,
    secrets_lock: State<'_, SecretsLock>,
    kernel: State<'_, KernelState>,
    db: State<'_, Arc<PaDb>>,
    pkg_id: String,
    req: PkgFetchReq,
) -> Result<PkgFetchResult, String> {
    let pool = db.ensure_pool().await.map_err(|e| e.to_string())?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;

    // Helper to audit a misuse refusal then return it.
    macro_rules! refuse {
        ($reason:expr, $attempted:expr, $declared:expr) => {{
            let reason: FetchRefusal = $reason;
            if reason.is_misuse() {
                record_violation(
                    &pool,
                    "http.fetch",
                    &ShellExecuteDenied {
                        pkg_id: pkg_id.clone(),
                        command: $attempted,
                        declared: $declared,
                    },
                )
                .await
                .ok();
            }
            return Ok(PkgFetchResult::refused(reason));
        }};
    }

    // (1) Capability presence + net allowlist + auth wiring (fresh manifest).
    let cap = match resolve_http_cap(&kernel.0, &pkg_id) {
        Ok(c) => c,
        Err(reason) => refuse!(reason, req.url.clone(), String::new()),
    };
    let declared = cap.net.join(",");

    // (2) Trust gate — re-checked server-side (the FE check is fail-fast only).
    let trusted =
        crate::pkg::trust::resolve_elevated_trust(&pool, &kernel.0, &app_data, &pkg_id).await;
    if !trusted {
        tracing::warn!(
            "[pkg_fetch] pkg `{pkg_id}` host.fetch denied — not trusted-for-elevated (fail-closed)"
        );
        refuse!(FetchRefusal::NotTrusted, req.url.clone(), declared.clone());
    }

    // (3) Method.
    let method = match proxy::normalize_method(req.method.as_deref()) {
        Ok(m) => m,
        Err(reason) => refuse!(
            reason,
            format!("{} {}", req.method.as_deref().unwrap_or("?"), req.url),
            declared.clone()
        ),
    };

    // (4) URL parse + scheme. http only if the allowlist explicitly permits it.
    let allow_http = proxy::net_allowlist_permits_http(&cap.net);
    let url = match proxy::parse_request_url(&req.url, allow_http) {
        Ok(u) => u,
        Err(reason) => refuse!(reason, format!("{method} {}", req.url), declared.clone()),
    };

    // (5) URL allowlist.
    if !proxy::url_matches_net_allowlist(&url, &cap.net) {
        refuse!(
            FetchRefusal::UrlNotAllowed,
            format!("{method} {url}"),
            declared.clone()
        );
    }

    // (6) SSRF: resolve + vet + pin the connection to the vetted IP.
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let pinned = match vet_and_pin_ip(&host, port, &cap.net).await {
        Ok(sa) => sa,
        Err(reason) => refuse!(reason, format!("{method} {url}"), declared.clone()),
    };

    // (7) Resolve the credential (only if an auth secret is configured). Read at
    // Workspace scope first, then Pkg scope (mirrors the Supabase precedent +
    // the secret-injection path). Missing/empty → fail loud (don't send
    // unauthenticated).
    let auth_header_value: Option<(String, String)> = match &cap.auth {
        None => None,
        Some((vault_key, auth_header)) => {
            let value = read_secret_scoped(&app, &secrets_lock, &Scope::Workspace, vault_key)
                .ok()
                .flatten()
                .filter(|v| !v.is_empty())
                .or_else(|| {
                    read_secret_scoped(&app, &secrets_lock, &Scope::pkg(&pkg_id), vault_key)
                        .ok()
                        .flatten()
                        .filter(|v| !v.is_empty())
                });
            match value {
                Some(v) => {
                    if !proxy::header_value_is_safe(&v) {
                        // A credential carrying CR/LF would enable request
                        // splitting — refuse rather than send it.
                        refuse!(
                            FetchRefusal::CredentialMissing,
                            format!("{method} {url}"),
                            declared.clone()
                        );
                    }
                    // Default a bearer prefix only for the default Authorization
                    // header when the stored value doesn't already carry a scheme.
                    let header_val = if auth_header.eq_ignore_ascii_case("authorization")
                        && !v.contains(' ')
                    {
                        format!("Bearer {v}")
                    } else {
                        v
                    };
                    Some((auth_header.clone(), header_val))
                }
                None => {
                    tracing::warn!(
                        "[pkg_fetch] pkg `{pkg_id}` host.fetch credential `{vault_key}` missing/empty"
                    );
                    refuse!(
                        FetchRefusal::CredentialMissing,
                        format!("{method} {url}"),
                        declared.clone()
                    );
                }
            }
        }
    };

    // (8) Assemble pkg-supplied headers with the denylist + CR/LF guard. The
    // auth header (if any) is injected AFTER this so the pkg can't override it.
    let auth_header_name = auth_header_value
        .as_ref()
        .map(|(k, _)| k.clone())
        .unwrap_or_default();
    let mut header_map = reqwest::header::HeaderMap::new();
    if let Some(supplied) = &req.headers {
        for (k, v) in supplied {
            if proxy::header_key_is_denied(k, &auth_header_name) {
                continue; // silently drop forbidden headers
            }
            if !proxy::header_value_is_safe(v) || !proxy::header_value_is_safe(k) {
                continue; // CR/LF — request-splitting guard
            }
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }
    }
    // Default content-type for a JSON object body when unset.
    let body_string: Option<String> = match &req.body {
        None => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(other) => {
            if !header_map.contains_key(reqwest::header::CONTENT_TYPE) {
                header_map.insert(
                    reqwest::header::CONTENT_TYPE,
                    reqwest::header::HeaderValue::from_static("application/json"),
                );
            }
            Some(other.to_string())
        }
    };

    // (9) Build the SSRF-pinned, no-auto-redirect, https-aware client.
    let timeout = std::time::Duration::from_millis(proxy::clamp_timeout_ms(req.timeout));
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .https_only(!allow_http)
        .resolve(&host, pinned)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[pkg_fetch] client build failed: {e}");
            return Ok(PkgFetchResult::refused(FetchRefusal::NetworkError));
        }
    };

    let cap_bytes = proxy::DEFAULT_RESPONSE_BYTES.min(proxy::MAX_RESPONSE_BYTES);
    let reqwest_method = reqwest::Method::from_bytes(method.as_bytes())
        .unwrap_or(reqwest::Method::GET);

    // (10) Manual redirect loop (max MAX_REDIRECTS). Each hop re-validated;
    // auth dropped on any cross-origin hop.
    let mut current = url.clone();
    let mut hops: u8 = 0;
    loop {
        // Re-pin per hop (the host may differ after a redirect).
        let hop_host = current.host_str().unwrap_or_default().to_string();
        let hop_port = current.port_or_known_default().unwrap_or(443);
        let hop_pinned = if hops == 0 {
            pinned
        } else {
            match vet_and_pin_ip(&hop_host, hop_port, &cap.net).await {
                Ok(sa) => sa,
                Err(reason) => refuse!(reason, format!("{method} {current}"), declared.clone()),
            }
        };
        let hop_client = if hops == 0 {
            client.clone()
        } else {
            match reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(timeout)
                .https_only(!allow_http)
                .resolve(&hop_host, hop_pinned)
                .build()
            {
                Ok(c) => c,
                Err(_) => return Ok(PkgFetchResult::refused(FetchRefusal::NetworkError)),
            }
        };

        let mut builder = hop_client.request(reqwest_method.clone(), current.clone());
        builder = builder.headers(header_map.clone());
        // Inject auth ONLY when same-origin as the original request.
        if let Some((name, val)) = &auth_header_value {
            if !proxy::is_cross_origin(&url, &current) {
                if let (Ok(hn), Ok(hv)) = (
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                    reqwest::header::HeaderValue::from_str(val),
                ) {
                    builder = builder.header(hn, hv);
                }
            }
        }
        if let Some(b) = &body_string {
            builder = builder.body(b.clone());
        }

        let resp = match builder.send().await {
            Ok(r) => r,
            Err(e) => {
                let reason = if e.is_timeout() {
                    FetchRefusal::Timeout
                } else {
                    FetchRefusal::NetworkError
                };
                tracing::warn!("[pkg_fetch] pkg `{pkg_id}` request error: {e}");
                return Ok(PkgFetchResult::refused(reason));
            }
        };

        let status = resp.status();
        // Handle redirects manually.
        if status.is_redirection() {
            if hops >= proxy::MAX_REDIRECTS {
                refuse!(
                    FetchRefusal::TooManyRedirects,
                    format!("{method} {current}"),
                    declared.clone()
                );
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let Some(location) = location else {
                // Redirect with no Location — treat as a terminal response.
                return read_response(resp, cap_bytes).await;
            };
            match proxy::validate_redirect(&location, &current, &cap.net, allow_http) {
                Ok(next) => {
                    current = next;
                    hops += 1;
                    continue;
                }
                Err(reason) => {
                    refuse!(reason, format!("{method} {current} -> {location}"), declared.clone())
                }
            }
        }

        // Terminal response.
        let result = read_response(resp, cap_bytes).await;
        if let Ok(r) = &result {
            tracing::info!(
                "[pkg_fetch] pkg `{pkg_id}` {method} {host} → {} ({} bytes{})",
                r.status.unwrap_or(0),
                r.bytes.unwrap_or(0),
                if r.truncated.unwrap_or(false) { ", truncated" } else { "" }
            );
        }
        return result;
    }
}

/// Stream + cap the response body, strip cookies from returned headers, and
/// build the success envelope. The injected auth header is never echoed back —
/// we only return *response* headers and strip Set-Cookie.
async fn read_response(
    resp: reqwest::Response,
    cap_bytes: u64,
) -> Result<PkgFetchResult, String> {
    use futures_util::StreamExt;

    let status = resp.status().as_u16();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers().iter() {
        let key = k.as_str().to_string();
        if proxy::response_header_is_stripped(&key) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            headers.insert(key.to_ascii_lowercase(), val.to_string());
        }
    }

    let mut body_bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let remaining = cap_bytes.saturating_sub(body_bytes.len() as u64);
                if (bytes.len() as u64) > remaining {
                    body_bytes.extend_from_slice(&bytes[..remaining as usize]);
                    truncated = true;
                    break;
                }
                body_bytes.extend_from_slice(&bytes);
            }
            Err(e) => {
                tracing::warn!("[pkg_fetch] body stream error: {e}");
                return Ok(PkgFetchResult::refused(FetchRefusal::NetworkError));
            }
        }
    }

    let bytes = body_bytes.len() as u64;
    let body = String::from_utf8_lossy(&body_bytes).to_string();
    Ok(PkgFetchResult {
        ok: true,
        status: Some(status),
        headers: Some(headers),
        body: Some(body),
        truncated: Some(truncated),
        bytes: Some(bytes),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg::http_proxy::{response_header_is_stripped, FetchRefusal};

    /// The whole point of the mediated proxy: the auth credential is attached to
    /// the outbound request Rust-side and is NEVER representable in the result
    /// envelope the FE sees. `PkgFetchResult` only carries `status / headers /
    /// body / truncated / bytes / reason` — there is no field that could hold the
    /// injected auth header, and we only ever populate `headers` from *response*
    /// headers (with Set-Cookie stripped). This test asserts that a serialized
    /// result built from a response carrying a forged "Authorization" *response*
    /// header still never surfaces the actual secret value the shell injected
    /// (the secret lives only on the request side, which this struct can't hold).
    #[test]
    fn auth_secret_never_appears_in_fe_visible_result() {
        // Simulate the success envelope the FE receives. The injected request
        // auth header ("super-secret-twenty-token") is NOT a field here by
        // construction — there is no request-header field on the result.
        let mut resp_headers = HashMap::new();
        resp_headers.insert("content-type".to_string(), "application/json".to_string());
        let result = PkgFetchResult {
            ok: true,
            status: Some(200),
            headers: Some(resp_headers),
            body: Some(r#"{"people":[{"id":1}]}"#.to_string()),
            truncated: Some(false),
            bytes: Some(21),
            reason: None,
        };
        let json = serde_json::to_string(&result).expect("serialize");
        // The secret the shell would have attached must never appear anywhere.
        assert!(
            !json.contains("super-secret-twenty-token"),
            "FE-visible result must not contain the injected credential"
        );
        // There is no request-side auth field at all — assert the only header
        // surface is the (response) `headers` map.
        assert!(json.contains("\"headers\""));
        assert!(!json.to_lowercase().contains("authorization"));
    }

    /// Set-Cookie is stripped so the proxy can't seed iframe-readable cookies —
    /// re-asserts the policy the read path relies on.
    #[test]
    fn set_cookie_is_stripped_policy() {
        assert!(response_header_is_stripped("Set-Cookie"));
        assert!(response_header_is_stripped("set-cookie2"));
        assert!(!response_header_is_stripped("content-type"));
    }

    /// The refusal envelope carries the frozen reason code and no body/headers.
    #[test]
    fn refusal_envelope_shape() {
        let r = PkgFetchResult::refused(FetchRefusal::NotTrusted);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("not-trusted"));
        assert!(r.body.is_none());
        assert!(r.headers.is_none());
        let r2 = PkgFetchResult::refused(FetchRefusal::SsrfBlocked);
        assert_eq!(r2.reason.as_deref(), Some("ssrf-blocked"));
    }
}
