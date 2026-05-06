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
        // Three-step rewrite:
        //   1. inline relative <script src> + <link rel="stylesheet" href>
        //      bodies into the HTML. WebKitGTK silently drops loopback
        //      subresource fetches from `about:srcdoc` documents (Tauri
        //      #12767 territory), so the only reliable way to ship the
        //      bundle into the iframe is to embed it in the document
        //      itself. Dynamic imports (which we cannot inline) still go
        //      via the axum content server using absolutized URLs.
        //   2. inject `<base href>` for any consumers that DO honour it.
        //   3. absolutize remaining relative `src=` / `href=` URLs (images,
        //      fonts, dynamic-import targets the bundler emitted as URLs).
        let html = inline_subresources(&raw, &canon_root);
        let html = inject_base_href(&html, &base_url);
        let html = inject_error_capture(&html);
        let html = absolutize_relative_urls(&html, &base_url);
        Ok(MintedHtml {
            html,
            base_url,
            token,
        })
    }
}

/// Rewrite `src="./..."` / `href="./..."` and bare relative paths
/// (`src="assets/..."`, `href="assets/..."`) to absolute `<base_url>` paths.
/// Defensive — `<base href>` SHOULD handle this, but WebKitGTK ignores `<base>`
/// in `srcdoc` documents on Linux, so we do the resolution ourselves.
///
/// Pure-string transform; we don't parse HTML. Only rewrites attributes whose
/// value starts with `./` or doesn't start with `/`, `http`, `data:`, `blob:`,
/// or `#` — i.e. clearly-relative subresource paths. Absolute URLs are left
/// alone, as are anchors and data URIs.
fn absolutize_relative_urls(html: &str, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let mut out = String::with_capacity(html.len() + 256);
    let mut i = 0;
    while i < html.len() {
        let rest = &html[i..];
        // Skip past any `<script>...</script>` or `<style>...</style>` block —
        // their contents are bundle bodies (post-inlining) and contain
        // arbitrary `src=`/`href=` literals we must not touch.
        if let Some((skip_to, prefix_len)) = next_skip_block(rest) {
            // skip_to is the index in `rest` of the opening `<` of script/style.
            // We process bytes [0..skip_to] for attribute rewriting, then copy
            // [skip_to..skip_to+prefix_len] (the whole tag + body + close) verbatim.
            let chunk = &rest[..skip_to];
            absolutize_chunk(chunk, base, &mut out);
            out.push_str(&rest[skip_to..skip_to + prefix_len]);
            i += skip_to + prefix_len;
            continue;
        }
        // No more skip blocks — process the rest normally and we're done.
        absolutize_chunk(rest, base, &mut out);
        break;
    }
    out
}

/// If `s` contains a `<script` or `<style>` opener, return (start, total_len)
/// where `total_len` covers the opening tag, body, and matching close tag.
/// Returns None if neither is present.
fn next_skip_block(s: &str) -> Option<(usize, usize)> {
    let lower = s.to_ascii_lowercase();
    let s_idx = lower.find("<script");
    let st_idx = lower.find("<style");
    let (start, close_tag) = match (s_idx, st_idx) {
        (Some(a), Some(b)) => {
            if a <= b { (a, "</script>") } else { (b, "</style>") }
        }
        (Some(a), None) => (a, "</script>"),
        (None, Some(b)) => (b, "</style>"),
        (None, None) => return None,
    };
    // Find end of opening tag (must close with `>` for it to count). For a
    // self-closing void use we'd not have a body; bail if no `</closeTag>`.
    let after_open_rel = lower[start..].find('>')?;
    let body_start = start + after_open_rel + 1;
    let close_rel = lower[body_start..].find(close_tag)?;
    let close_end = body_start + close_rel + close_tag.len();
    Some((start, close_end - start))
}

fn absolutize_chunk(html: &str, base: &str, out: &mut String) {
    let mut i = 0;
    while i < html.len() {
        let rest = &html[i..];
        let attr_start = rest
            .find("src=\"")
            .or_else(|| rest.find("src='"))
            .or_else(|| rest.find("href=\""))
            .or_else(|| rest.find("href='"))
            .or_else(|| rest.find("SRC=\""))
            .or_else(|| rest.find("HREF=\""));
        let attr_idx = match attr_start {
            Some(p) => p,
            None => {
                out.push_str(rest);
                break;
            }
        };
        // Copy everything up to and including the opening quote.
        let attr_open = attr_idx
            + rest[attr_idx..]
                .find(|c| c == '"' || c == '\'')
                .map(|p| p + 1)
                .unwrap_or(0);
        out.push_str(&rest[..attr_open]);
        let quote = rest.as_bytes()[attr_open - 1] as char;
        let val_start = attr_open;
        let val_end = rest[val_start..]
            .find(quote)
            .map(|p| val_start + p)
            .unwrap_or(rest.len());
        let value = &rest[val_start..val_end];
        let should_rewrite = !(value.is_empty()
            || value.starts_with('/')
            || value.starts_with('#')
            || value.starts_with("http://")
            || value.starts_with("https://")
            || value.starts_with("data:")
            || value.starts_with("blob:")
            || value.starts_with("about:")
            || value.starts_with("mailto:")
            || value.starts_with("javascript:"));
        if should_rewrite {
            let trimmed = value.trim_start_matches("./");
            out.push_str(base);
            out.push('/');
            out.push_str(trimmed);
        } else {
            out.push_str(value);
        }
        // Advance past the value (caller's loop will pick up the closing quote
        // and onward).
        i += val_end;
    }
}

/// Replace relative `<script src="…">` and `<link rel="stylesheet" href="…">`
/// tags with their on-disk contents inlined as `<script>` / `<style>`.
///
/// Why: WebKitGTK on Linux refuses to issue subresource fetches from
/// `about:srcdoc` iframes targeting `http://127.0.0.1:*` (Tauri #12767
/// territory). `<base href>` and absolutized URLs both fail. Inlining is
/// the only reliable path. Dynamic imports inside the bundle still go
/// through the axum server (those URLs survive `absolutize_relative_urls`).
///
/// Pure string transform — we don't parse HTML. Only acts on tags whose
/// `src` / `href` value is a relative path (no scheme, no leading `/`).
/// Reads strictly inside `dist_root`; rejects path traversal.
fn inline_subresources(html: &str, dist_root: &Path) -> String {
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    while cursor < html.len() {
        let rest = &html[cursor..];
        let s_idx = find_case_insensitive(rest, "<script");
        let l_idx = find_case_insensitive(rest, "<link");
        let (tag_rel, is_script) = match (s_idx, l_idx) {
            (Some(s), Some(l)) => {
                if s <= l { (s, true) } else { (l, false) }
            }
            (Some(s), None) => (s, true),
            (None, Some(l)) => (l, false),
            (None, None) => {
                out.push_str(rest);
                break;
            }
        };
        let tag_start = cursor + tag_rel;
        out.push_str(&html[cursor..tag_start]);
        // Find end of opening tag.
        let open_end_rel = match html[tag_start..].find('>') {
            Some(p) => p + 1,
            None => {
                out.push_str(&html[tag_start..]);
                break;
            }
        };
        let open_end = tag_start + open_end_rel;
        let open_tag = &html[tag_start..open_end];

        if is_script {
            if let Some(src) = extract_attr(open_tag, "src") {
                if is_relative_url(&src) {
                    let close_search = &html[open_end..];
                    if let Some(close_rel) = find_case_insensitive(close_search, "</script>") {
                        let close_end = open_end + close_rel + "</script>".len();
                        match read_subresource(dist_root, &src) {
                            Ok(content) => {
                                let lower = open_tag.to_ascii_lowercase();
                                let is_module = lower.contains("type=\"module\"")
                                    || lower.contains("type='module'");
                                if is_module {
                                    out.push_str("<script type=\"module\">");
                                } else {
                                    out.push_str("<script>");
                                }
                                // Avoid breaking out of the script context if
                                // the bundle contains a literal `</script>`.
                                out.push_str(&content.replace("</script", "<\\/script"));
                                out.push_str("</script>");
                                cursor = close_end;
                                continue;
                            }
                            Err(e) => {
                                log::warn!(
                                    "[pkg_content] inline script {src} failed: {e}"
                                );
                            }
                        }
                    }
                }
            }
            out.push_str(open_tag);
            cursor = open_end;
        } else {
            // <link>
            let lower = open_tag.to_ascii_lowercase();
            let is_stylesheet = lower.contains("rel=\"stylesheet\"")
                || lower.contains("rel='stylesheet'")
                || lower.contains("rel=stylesheet");
            if is_stylesheet {
                if let Some(href) = extract_attr(open_tag, "href") {
                    if is_relative_url(&href) {
                        match read_subresource(dist_root, &href) {
                            Ok(content) => {
                                out.push_str("<style>");
                                out.push_str(&content.replace("</style", "<\\/style"));
                                out.push_str("</style>");
                                cursor = open_end;
                                continue;
                            }
                            Err(e) => {
                                log::warn!(
                                    "[pkg_content] inline stylesheet {href} failed: {e}"
                                );
                            }
                        }
                    }
                }
            }
            out.push_str(open_tag);
            cursor = open_end;
        }
    }
    out
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needles = [
        (format!("{}=\"", name.to_ascii_lowercase()), '"'),
        (format!("{}='", name.to_ascii_lowercase()), '\''),
    ];
    for (needle, quote) in &needles {
        if let Some(p) = lower.find(needle) {
            // Make sure we matched on a word boundary (preceded by space, tab,
            // newline, or `<` for the opener case — but `<name=` doesn't
            // happen for real attributes, so just check the preceding char).
            if p > 0 {
                let prev = tag.as_bytes()[p - 1];
                if !(prev == b' ' || prev == b'\t' || prev == b'\n' || prev == b'\r') {
                    continue;
                }
            }
            let val_start = p + needle.len();
            let rest = &tag[val_start..];
            if let Some(end) = rest.find(*quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn is_relative_url(url: &str) -> bool {
    !(url.is_empty()
        || url.starts_with('/')
        || url.starts_with('#')
        || url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("data:")
        || url.starts_with("blob:")
        || url.starts_with("about:")
        || url.starts_with("mailto:")
        || url.starts_with("javascript:"))
}

fn read_subresource(dist_root: &Path, url: &str) -> Result<String> {
    // Strip query string + fragment. Vite emits hashed filenames so we don't
    // expect either, but be defensive.
    let bare = url.split(['?', '#']).next().unwrap_or(url);
    let trimmed = bare.trim_start_matches("./").trim_start_matches('/');
    let abs = dist_root.join(trimmed);
    let canon = abs
        .canonicalize()
        .with_context(|| format!("canonicalize {}", abs.display()))?;
    if !canon.starts_with(dist_root) {
        return Err(anyhow!(
            "subresource `{url}` resolves outside dist_root"
        ));
    }
    std::fs::read_to_string(&canon).with_context(|| format!("read {}", canon.display()))
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

/// Inject a tiny error-capture script as the FIRST element inside `<head>`,
/// before the inlined bundle. Stashes uncaught errors + rejections on
/// `window.__pkgErrors` so the parent can read them post-load. Diagnostic-only
/// for the iframe smoke debug; safe to keep in production (cheap, no side
/// effects beyond the global array).
fn inject_error_capture(html: &str) -> String {
    let snippet = "<script>window.__pkgErrors=[];addEventListener('error',function(e){window.__pkgErrors.push({type:'error',msg:e.message,filename:e.filename,line:e.lineno,col:e.colno,stack:e.error&&e.error.stack});});addEventListener('unhandledrejection',function(e){window.__pkgErrors.push({type:'unhandledrejection',reason:String(e.reason),stack:e.reason&&e.reason.stack});});</script>";
    if let Some(idx) = find_case_insensitive(html, "<head>") {
        let insert_at = idx + "<head>".len();
        let mut out = String::with_capacity(html.len() + snippet.len());
        out.push_str(&html[..insert_at]);
        out.push_str(snippet);
        out.push_str(&html[insert_at..]);
        out
    } else {
        format!("{}{}", snippet, html)
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
