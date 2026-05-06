//! Content server for installed packages' iframe UI.
//!
//! One axum process bound to `127.0.0.1:0` at app boot. Routes:
//!
//! ```text
//! GET /<pkg_id>/<token>/<file>     → serves <install_path>/dist/<file>
//! GET /<pkg_id>/<token>/           → serves <install_path>/dist/index.html
//! ```
//!
//! The token is per-iframe-mount (not per-pkg). `mint()` is called when a
//! `<PkgIframeHost>` mounts; `revoke()` on unmount; `revoke_pkg()` on
//! uninstall. Untokenized requests get 404 — the port is still discoverable
//! but the secret is not.
//!
//! Per-request CSP and Permission-Policy headers are built from the
//! manifest's optional `ui.csp` / `ui.permissions` blocks, layered over a
//! default-deny baseline. The server itself implements `pkg::Registry` so
//! the kernel's install/uninstall lifecycle drives content registration:
//! a pkg with no `ui.routes` of `kind: "iframe"` is a no-op here.
//!
//! Why a single server, not one per pkg: simpler lifecycle, fewer ports,
//! and the per-token check + per-pkg path prefix already give us isolation.
//! Mirrors the design of `viewer_server` next door but adds pkg awareness.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderName, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use dashmap::DashMap;
use serde_json::{json, Value};
use tower::util::ServiceExt;
use tower_http::services::ServeDir;

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

/// Default CSP — directive → space-separated source list. Manifest entries
/// in `ui.csp` replace the value for a directive (not append). Unset
/// directives fall back to these defaults.
const DEFAULT_CSP: &[(&str, &str)] = &[
    ("default-src", "'self'"),
    ("script-src", "'self' 'unsafe-inline'"),
    ("style-src", "'self' 'unsafe-inline'"),
    ("img-src", "'self' data: blob:"),
    ("font-src", "'self' data:"),
    ("connect-src", "'self'"),
    ("frame-ancestors", "'self'"),
    ("base-uri", "'self'"),
];

#[derive(Clone)]
struct PkgEntry {
    /// Absolute path to `<install_path>/dist`.
    dist_root: PathBuf,
    /// `ui.csp` overrides from the manifest. Directive → source list.
    csp_overrides: HashMap<String, Vec<String>>,
    /// `ui.permissions` overrides → Permission-Policy directives.
    perm_overrides: HashMap<String, Vec<String>>,
}

#[derive(Clone)]
struct TokenEntry {
    pkg_id: String,
}

pub struct PkgContentServer {
    /// pkg_id → registered content entry (set on `register`, removed on
    /// `unregister`). Packages without an iframe-kind ui route are absent.
    pkgs: DashMap<String, PkgEntry>,

    /// token → which pkg it grants access to. Minted by `mint()`, dropped by
    /// `revoke()` / `revoke_pkg()`. A request must present a token whose
    /// `pkg_id` matches the URL's pkg segment.
    tokens: DashMap<String, TokenEntry>,

    /// pkg_id → list of live tokens, so uninstall can drop them all.
    tokens_by_pkg: DashMap<String, Vec<String>>,

    /// Set after `start()` succeeds. `mint()` errors if the server hasn't
    /// bound yet (would be a setup-order bug).
    bound_addr: OnceLock<SocketAddr>,
}

impl PkgContentServer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pkgs: DashMap::new(),
            tokens: DashMap::new(),
            tokens_by_pkg: DashMap::new(),
            bound_addr: OnceLock::new(),
        })
    }

    /// Bind on an ephemeral port and spawn the server task. Idempotent —
    /// second call is a no-op.
    pub async fn start(self: Arc<Self>) -> Result<SocketAddr> {
        if let Some(addr) = self.bound_addr.get() {
            return Ok(*addr);
        }
        let app = Router::new()
            .route("/:pkg_id/:token/", any(serve_index))
            .route("/:pkg_id/:token", any(serve_index))
            .route("/:pkg_id/:token/*path", any(serve_path))
            .with_state(self.clone());
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .context("bind pkg_content listener")?;
        let addr = listener.local_addr().context("local_addr")?;
        self.bound_addr
            .set(addr)
            .map_err(|_| anyhow!("pkg_content server already started"))?;
        log::info!("pkg_content server: bound at http://{}", addr);
        tokio::spawn(async move {
            let server = axum::serve(listener, app.into_make_service());
            if let Err(e) = server.await {
                log::warn!("pkg_content server exited: {e}");
            }
        });
        Ok(addr)
    }

    /// Mint a per-iframe access token for `pkg_id`. Errors if the pkg isn't
    /// registered (no iframe-kind route declared) or the server isn't
    /// running. Returns a fully-qualified URL ending in `/` plus the token.
    pub fn mint(&self, pkg_id: &str) -> Result<MintedHandle> {
        let addr = self
            .bound_addr
            .get()
            .ok_or_else(|| anyhow!("pkg_content server not started"))?;
        if !self.pkgs.contains_key(pkg_id) {
            return Err(anyhow!(
                "pkg `{pkg_id}` has no iframe content registered"
            ));
        }
        let token = random_token_hex(32);
        self.tokens.insert(
            token.clone(),
            TokenEntry {
                pkg_id: pkg_id.to_string(),
            },
        );
        self.tokens_by_pkg
            .entry(pkg_id.to_string())
            .or_default()
            .push(token.clone());
        let url = format!("http://{}/{}/{}/", addr, pkg_id, token);
        Ok(MintedHandle { url, token })
    }

    /// Revoke a single token (iframe unmount).
    pub fn revoke(&self, token: &str) {
        if let Some((_, entry)) = self.tokens.remove(token) {
            if let Some(mut list) = self.tokens_by_pkg.get_mut(&entry.pkg_id) {
                list.retain(|t| t != token);
            }
        }
    }

    /// Revoke every token for a pkg. Called on uninstall.
    fn revoke_pkg(&self, pkg_id: &str) {
        if let Some((_, tokens)) = self.tokens_by_pkg.remove(pkg_id) {
            for t in tokens {
                self.tokens.remove(&t);
            }
        }
    }

    /// Mint a token, read the named html file from the pkg's dist/, and
    /// inject a `<base href>` pointing at the per-token subresource URL.
    /// Used by the iframe host's `srcdoc=` path — see the Linux/WebKitGTK
    /// note in `commands/pkg_content.rs`.
    pub fn mint_html(&self, pkg_id: &str, source: &str) -> Result<MintedHtml> {
        let entry = self
            .pkgs
            .get(pkg_id)
            .ok_or_else(|| anyhow!("pkg `{pkg_id}` has no iframe content registered"))?
            .clone();
        // Strip leading `dist/` (manifest convention) and any leading slash so
        // we always read relative to dist_root.
        let rel = source
            .trim_start_matches('/')
            .strip_prefix("dist/")
            .unwrap_or_else(|| source.trim_start_matches('/'));
        let abs = entry.dist_root.join(rel);
        // Defense in depth: confirm the resolved path is still within
        // dist_root (no `../` traversal).
        let canon_root = entry
            .dist_root
            .canonicalize()
            .with_context(|| format!("canonicalize dist_root {}", entry.dist_root.display()))?;
        let canon_abs = abs
            .canonicalize()
            .with_context(|| format!("canonicalize html path {}", abs.display()))?;
        if !canon_abs.starts_with(&canon_root) {
            return Err(anyhow!(
                "source `{source}` resolves outside dist_root"
            ));
        }
        let raw = std::fs::read_to_string(&canon_abs)
            .with_context(|| format!("read {}", canon_abs.display()))?;

        let MintedHandle { url: base_url, token } = self.mint(pkg_id)?;
        let html = inject_base_href(&raw, &base_url);
        Ok(MintedHtml {
            html,
            base_url,
            token,
        })
    }
}

pub struct MintedHandle {
    pub url: String,
    pub token: String,
}

pub struct MintedHtml {
    /// Full HTML body with `<base href>` injected. Pass to iframe `srcdoc`.
    pub html: String,
    /// Subresource base URL — `http://127.0.0.1:<port>/<pkg_id>/<token>/`.
    /// Exposed for diagnostics; the iframe shouldn't need it directly because
    /// `<base href>` is already in the HTML.
    pub base_url: String,
    /// Per-iframe token — pass to `revoke()` on unmount.
    pub token: String,
}

/// Inject a `<base href="<base_url>">` into the HTML's `<head>` so relative
/// subresource loads (`./app.js`, `styles.css`) resolve against the per-token
/// pkg-content URL. Pure-string transform: we don't parse HTML. If `<head>`
/// is missing we prepend a synthetic head (rare for real packages but the
/// no-script smoke fixtures relied on it).
fn inject_base_href(html: &str, base_url: &str) -> String {
    let tag = format!("<base href=\"{}\">", base_url);
    if let Some(idx) = find_case_insensitive(html, "<head>") {
        let insert_at = idx + "<head>".len();
        let mut out = String::with_capacity(html.len() + tag.len());
        out.push_str(&html[..insert_at]);
        out.push_str(&tag);
        out.push_str(&html[insert_at..]);
        out
    } else if let Some(idx) = find_case_insensitive(html, "<html") {
        // No <head>: insert one right after <html ...> (closing >).
        let after_html = html[idx..]
            .find('>')
            .map(|p| idx + p + 1)
            .unwrap_or(html.len());
        let mut out = String::with_capacity(html.len() + tag.len() + 16);
        out.push_str(&html[..after_html]);
        out.push_str("<head>");
        out.push_str(&tag);
        out.push_str("</head>");
        out.push_str(&html[after_html..]);
        out
    } else {
        // Headless fragment — prepend tag.
        format!("{}{}", tag, html)
    }
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let lower = haystack.to_ascii_lowercase();
    lower.find(&needle.to_ascii_lowercase())
}

impl Registry for PkgContentServer {
    fn name(&self) -> &'static str {
        "pkg_content"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        // Only register packages that declare at least one iframe-kind route.
        // Component-kind routes are advisory (host-builtin marker installs)
        // and don't need content serving.
        let ui = match &pkg.manifest.ui {
            Some(b) => b,
            None => return Ok(()),
        };
        let has_iframe = ui.routes.iter().any(|r| r.kind == "iframe");
        if !has_iframe {
            return Ok(());
        }
        let dist_root = pkg.install_path.join("dist");
        // Don't error on a missing dist dir — tolerate marker-style installs
        // for fixtures that haven't shipped a bundle yet. mint() will surface
        // the failure when an iframe actually tries to mount.
        if !dist_root.is_dir() {
            log::info!(
                "[pkg_content] {} declares iframe routes but has no dist/ at {}",
                pkg.manifest.id,
                dist_root.display()
            );
        }
        let csp_overrides = ui.csp.clone().unwrap_or_default();
        let perm_overrides = ui.permissions.clone().unwrap_or_default();
        self.pkgs.insert(
            pkg.manifest.id.clone(),
            PkgEntry {
                dist_root,
                csp_overrides,
                perm_overrides,
            },
        );
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        self.pkgs.remove(pkg_id);
        self.revoke_pkg(pkg_id);
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let pkgs: Vec<Value> = self
            .pkgs
            .iter()
            .map(|e| {
                json!({
                    "pkg_id": e.key(),
                    "dist_root": e.dist_root.display().to_string(),
                    "dist_exists": e.dist_root.is_dir(),
                    "csp_overrides": e.csp_overrides,
                    "perm_overrides": e.perm_overrides,
                })
            })
            .collect();
        json!({
            "bound_addr": self.bound_addr.get().map(|a| a.to_string()),
            "pkg_count": pkgs.len(),
            "active_tokens": self.tokens.len(),
            "pkgs": pkgs,
        })
    }
}

async fn serve_index(
    State(server): State<Arc<PkgContentServer>>,
    AxumPath((pkg_id, token)): AxumPath<(String, String)>,
    req: Request<Body>,
) -> Response {
    serve_with_token(server, &pkg_id, &token, "index.html", req).await
}

async fn serve_path(
    State(server): State<Arc<PkgContentServer>>,
    AxumPath((pkg_id, token, path)): AxumPath<(String, String, String)>,
    req: Request<Body>,
) -> Response {
    serve_with_token(server, &pkg_id, &token, &path, req).await
}

async fn serve_with_token(
    server: Arc<PkgContentServer>,
    pkg_id: &str,
    token: &str,
    rel_path: &str,
    mut req: Request<Body>,
) -> Response {
    let token_entry = match server.tokens.get(token) {
        Some(e) => e.clone(),
        None => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if token_entry.pkg_id != pkg_id {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let pkg_entry = match server.pkgs.get(pkg_id) {
        Some(e) => e.clone(),
        None => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !pkg_entry.dist_root.is_dir() {
        return (StatusCode::NOT_FOUND, "pkg has no dist/").into_response();
    }

    let uri_str = if rel_path.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", rel_path)
    };
    let new_uri = match uri_str.parse() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad path").into_response(),
    };
    *req.uri_mut() = new_uri;

    let svc = ServeDir::new(&pkg_entry.dist_root);
    let mut resp = match svc.oneshot(req).await {
        Ok(r) => r.into_response(),
    };
    let csp = build_csp(&pkg_entry.csp_overrides);
    if let Ok(v) = HeaderValue::from_str(&csp) {
        resp.headers_mut().insert(header::CONTENT_SECURITY_POLICY, v);
    }
    let perm_policy = build_permission_policy(&pkg_entry.perm_overrides);
    if !perm_policy.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&perm_policy) {
            resp.headers_mut()
                .insert(HeaderName::from_static("permissions-policy"), v);
        }
    }
    resp.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    resp.headers_mut()
        .insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    // CORS: subresources are fetched cross-origin from the srcdoc iframe
    // (which inherits the parent's tauri:// origin) to this http loopback
    // server. ESM module imports require CORS headers; non-module
    // subresources work even without it. We allow `*` because the per-token
    // path already gates access — without the token the request 404s before
    // any content is served.
    resp.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    resp
}

fn build_csp(overrides: &HashMap<String, Vec<String>>) -> String {
    let mut directives: Vec<(String, String)> = DEFAULT_CSP
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    for (k, v) in overrides {
        let merged = v.join(" ");
        if let Some(existing) = directives.iter_mut().find(|(d, _)| d == k) {
            existing.1 = merged;
        } else {
            directives.push((k.clone(), merged));
        }
    }
    directives
        .into_iter()
        .map(|(k, v)| format!("{} {}", k, v))
        .collect::<Vec<_>>()
        .join("; ")
}

fn build_permission_policy(overrides: &HashMap<String, Vec<String>>) -> String {
    overrides
        .iter()
        .map(|(directive, sources)| {
            if sources.is_empty() {
                format!("{}=()", directive)
            } else {
                format!("{}=({})", directive, sources.join(" "))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn random_token_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[allow(dead_code)]
fn touch(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_csp_uses_defaults_when_no_overrides() {
        let csp = build_csp(&HashMap::new());
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn build_csp_overrides_replace_directive() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "script-src".to_string(),
            vec!["'self'".to_string(), "https://cdn.example.com".to_string()],
        );
        let csp = build_csp(&overrides);
        assert!(csp.contains("script-src 'self' https://cdn.example.com"));
        // default-src untouched
        assert!(csp.contains("default-src 'self'"));
    }

    #[test]
    fn build_csp_adds_unknown_directive() {
        let mut overrides = HashMap::new();
        overrides.insert("worker-src".to_string(), vec!["'self'".to_string()]);
        let csp = build_csp(&overrides);
        assert!(csp.contains("worker-src 'self'"));
    }

    #[test]
    fn permission_policy_empty_sources_blocks() {
        let mut overrides = HashMap::new();
        overrides.insert("camera".to_string(), Vec::new());
        let pp = build_permission_policy(&overrides);
        assert_eq!(pp, "camera=()");
    }

    #[test]
    fn permission_policy_with_sources() {
        let mut overrides = HashMap::new();
        overrides.insert("clipboard-read".to_string(), vec!["'self'".to_string()]);
        let pp = build_permission_policy(&overrides);
        assert_eq!(pp, "clipboard-read=('self')");
    }
}
