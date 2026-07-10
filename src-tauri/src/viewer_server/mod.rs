//! Shared in-process axum server for previewing local HTML artifacts inside
//! the shell. There is exactly one server per app launch — `viewer_serve`
//! registers a `(token, root)` mount in a shared registry; `viewer_stop`
//! removes it. All requests come in under `/__viewer/{token}/*path`.
//!
//! Why one server, not one per mount: the previous design bound a fresh
//! `127.0.0.1:0` socket per mount, which gave each iframe a *different*
//! origin from the shell. That blocked cross-document DOM access (iyke walk,
//! `modern-screenshot` reach-in). With a single fixed port and the dev-time
//! Vite proxy / prod-time `tauri-plugin-localhost` mount on the same origin
//! as the FE, every artifact iframe is now same-origin with the shell.
//!
//! Token gating is unchanged: a request whose token isn't in the registry
//! gets a 404, in constant time.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use axum::body::{to_bytes, Body};
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use dashmap::DashMap;
use tower::util::ServiceExt;
use tower_http::services::ServeDir;

/// Iyke iframe bridge, bundled from `src/lib/iyke/iframe-bridge.entry.ts`
/// via `bun run iyke:bundle` (chained from `bun run dev` and `bun run
/// build`). Injected into every served HTML response so author-written
/// previews (design concepts, Claude artifacts) can be driven by the iyke
/// CLI the same way the sidecar mini-apps can.
const IYKE_BRIDGE_JS: &str = include_str!("../../resources/iyke-iframe-bridge.js");

/// Marker so the inject middleware doesn't double-inject if the response
/// somehow flows through twice (defensive — the layer order shouldn't allow
/// it today).
const IYKE_INJECT_MARKER: &str = "<!-- iyke-bridge-injected -->";

/// Ikenga artifact bridge, bundled from `src/lib/artifact/bridge.entry.ts`
/// via `bun run artifact:bundle`. Sets up `window.__ikenga_host__` and
/// `window.__ikenga_bridge_polyfill__` so the host-injected runtime takes
/// over from the per-artifact inline polyfill when the artifact is opened
/// inside the shell. Outside the shell (claude.ai, file://) the artifact's
/// own inline polyfill remains the bridge.
const ARTIFACT_BRIDGE_JS: &str = include_str!("../../resources/artifact-iframe-bridge.js");

/// Marker so the inject middleware doesn't double-inject if the response
/// somehow flows through twice.
const ARTIFACT_INJECT_MARKER: &str = "<!-- ikenga-artifact-bridge-injected -->";

/// `@ikenga/tokens` design tokens, copied from `tokens/tokens.css` into
/// `resources/ikenga-tokens.css` by the `tokens:copy` npm script (chained from
/// `bun run dev` / `build`). Injected as an inline `<style>` into every served
/// artifact so the shell palette's CSS custom properties resolve in-frame —
/// the tokens key off `:root[data-mode='…']` / `[data-theme='…'][data-mode='…']`
/// attributes, which the artifact bridge mirrors from the shell's `<html>`.
/// Inline (not a `<link>`) so there's no extra fetch and no flash; `<style>`
/// inline is permitted by `VIEWER_CSP`.
const IKENGA_TOKENS_CSS: &str = include_str!("../../resources/ikenga-tokens.css");

/// Cap the buffered body before injection. Anything bigger gets returned
/// untouched — viewer pages are hand-written HTML, megabyte-sized payloads
/// would be a data file mislabeled as HTML.
const HTML_INJECT_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Content-Security-Policy injected on every viewer-served response.
///
/// Allows inline scripts/styles (Claude-generated HTML artifacts use them
/// heavily) and the four CDN hosts the `ikenga-artifact-builder` skill
/// documents as the canonical script sources (React/ReactDOM UMD, Babel-
/// standalone, Tailwind, esm.sh). Image and font hosts are broader — real
/// artifacts pull from Wikimedia, Met Museum, Unsplash, etc. — but
/// `connect-src` stays at `'self'` so artifacts can't make ad-hoc fetch()
/// calls to arbitrary hosts; data must flow through declared dataSources
/// (resolved by the shell bridge, not the iframe).
const VIEWER_CSP: &str = "default-src 'self' data: blob:; \
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://esm.sh https://cdn.skypack.dev; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com; \
img-src 'self' data: blob: https:; \
font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; \
media-src 'self' blob: https:; \
connect-src 'self'";

/// Default fixed port. Override with `IKENGA_VIEWER_PORT` if it conflicts.
/// Picked from the IANA-unreserved range; deliberately stable so the Vite
/// dev-proxy config can hardcode it.
const DEFAULT_VIEWER_PORT: u16 = 47821;

/// URL path prefix for all viewer routes. Mirrored in `vite.config.ts`
/// proxy config and in the prod `tauri-plugin-localhost` router merge.
pub const VIEWER_PATH_PREFIX: &str = "/__viewer";

#[derive(Clone)]
struct Mount {
    root: PathBuf,
}

pub struct ViewerServerManager {
    mounts: Arc<DashMap<String, Mount>>,
    /// Set once at startup by `start`.
    bound_port: RwLock<Option<u16>>,
}

impl ViewerServerManager {
    pub fn new() -> Self {
        Self {
            mounts: Arc::new(DashMap::new()),
            bound_port: RwLock::new(None),
        }
    }

    /// Register a mount. Returns `(url_path_prefix, token)` — the URL is a
    /// shell-origin-relative path like `/__viewer/<token>/`. Callers append
    /// the file path. The actual host:port is whatever the shell loads from
    /// (Vite in dev, localhost-plugin in prod), reached via proxy/route.
    pub fn register(&self, root: PathBuf) -> (String, String) {
        let token = random_token_hex(32);
        self.mounts
            .insert(token.clone(), Mount { root: root.clone() });
        let url = format!("{VIEWER_PATH_PREFIX}/{}/", token);
        tracing::info!(
            "viewer mount: serving {} at {} (token {})",
            root.display(),
            url,
            &token[..8]
        );
        (url, token)
    }

    pub fn unregister(&self, token: &str) {
        if self.mounts.remove(token).is_some() {
            tracing::info!("viewer mount: unregistered token {}", &token[..8]);
        }
    }

    pub fn bound_port(&self) -> Option<u16> {
        *self.bound_port.read().unwrap()
    }

    /// Spawn the singleton server. Idempotent: subsequent calls are no-ops
    /// if the server is already bound.
    ///
    /// In prod, the Tauri webview is configured (via `tauri.conf.json`
    /// `frontendDist: "http://localhost:47821/"`) to load the shell itself
    /// from this server, so a fallback route serves the bundled frontend
    /// dist via Tauri's `AssetResolver`. That makes the shell and every
    /// `/__viewer/*` iframe share an origin in prod — which is what makes
    /// `iframe.contentDocument` access (Studio comment-mode, modern-screenshot,
    /// iyke iframe bridge) work end-to-end. In dev, Vite serves the shell
    /// from `http://localhost:1420` and proxies `/__viewer/*` here; the
    /// asset fallback never fires because nothing requests it.
    pub async fn start<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: &tauri::AppHandle<R>,
    ) -> Result<u16> {
        if let Some(p) = self.bound_port() {
            return Ok(p);
        }

        let port: u16 = std::env::var("IKENGA_VIEWER_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_VIEWER_PORT);

        let mounts = self.mounts.clone();
        let viewer_router: Router = Router::new()
            .route("/__viewer/:token/*path", any(serve_handler))
            .route("/__viewer/:token", any(serve_handler_root))
            // Health probe so the FE can confirm the server is up before
            // mounting an iframe (avoids a flash of "viewer offline").
            .route("/__viewer-health", any(health_handler))
            .layer(middleware::from_fn(inject_artifact_bridge))
            .layer(middleware::from_fn(inject_iyke_bridge))
            .layer(middleware::from_fn(inject_security_headers))
            .with_state(mounts);

        // Catch-all: serve the bundled frontend dist via Tauri's asset
        // resolver. Wrap in `Arc` because `AssetResolver<R>` is only `Clone`
        // when `R: Clone`, and Tauri's `Wry` runtime isn't `Clone`. The
        // injection middlewares above are scoped by URI prefix to viewer
        // routes only, so frontend assets pass through unmodified.
        let asset_resolver = Arc::new(app.asset_resolver());
        let app: Router = viewer_router.fallback(any(move |req: Request<Body>| {
            let resolver = asset_resolver.clone();
            async move { serve_frontend_asset(&resolver, req) }
        }));

        // Try the preferred port (47821 by default) first so a fresh launch is
        // predictable, but fall back to an OS-chosen port if it's in use. This
        // keeps two concurrent Ikenga instances (e.g. prod + dev) from fighting
        // over the same port — the second one transparently picks something
        // free. The actual bound port is returned, threaded into the shell's
        // window URL by `lib.rs` so the webview always loads from the right
        // place.
        let listener =
            match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                Ok(l) => l,
                Err(e) if port != 0 => {
                    tracing::warn!(
                        "[viewer] port {port} unavailable ({e}); falling back to OS-assigned port"
                    );
                    tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                        .await
                        .context("bind viewer listener on OS-assigned port")?
                }
                Err(e) => return Err(e).context("bind viewer listener"),
            };
        let local_addr = listener.local_addr().context("local_addr")?;
        let bound = local_addr.port();

        *self.bound_port.write().unwrap() = Some(bound);

        tokio::spawn(async move {
            let server = axum::serve(listener, app.into_make_service());
            if let Err(e) = server.await {
                tracing::warn!("viewer server exited: {e}");
            }
        });

        tracing::info!("viewer server: listening on http://127.0.0.1:{bound}{VIEWER_PATH_PREFIX}/");
        Ok(bound)
    }
}

async fn health_handler() -> Response {
    (StatusCode::OK, "ok").into_response()
}

/// Serve a request out of Tauri's bundled frontend dist via the
/// `AssetResolver`. In prod the shell's `frontendDist` points at this server
/// (`http://localhost:47821/`), so the shell webview's own document, JS, and
/// CSS all flow through here. In dev, Vite serves the shell directly so this
/// is never invoked.
fn serve_frontend_asset<R: tauri::Runtime>(
    resolver: &Arc<tauri::AssetResolver<R>>,
    req: Request<Body>,
) -> Response {
    // `AssetResolver::get` keys off the URL path (sans query string), with
    // `/` resolving to `index.html`. Empty paths defensive-fall back to root.
    let mut path = req.uri().path().to_string();
    if path.is_empty() || path == "/" {
        path = "/index.html".to_string();
    }
    match resolver.get(path) {
        Some(asset) => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, &asset.mime_type)
                // Disable caching during development to avoid stale chunks
                // after a `tauri build` + reinstall.
                .header(header::CACHE_CONTROL, "no-cache");
            if let Some(csp) = &asset.csp_header {
                builder = builder.header(header::CONTENT_SECURITY_POLICY, csp);
            }
            builder.body(Body::from(asset.bytes)).unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "asset build failed").into_response()
            })
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn serve_handler(
    State(mounts): State<Arc<DashMap<String, Mount>>>,
    AxumPath((token, path)): AxumPath<(String, String)>,
    req: Request<Body>,
) -> Response {
    let Some(mount) = mounts.get(&token).map(|m| m.clone()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    serve_file(&mount.root, &path, req).await
}

async fn serve_handler_root(
    State(mounts): State<Arc<DashMap<String, Mount>>>,
    AxumPath(token): AxumPath<String>,
    req: Request<Body>,
) -> Response {
    let Some(mount) = mounts.get(&token).map(|m| m.clone()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    serve_file(&mount.root, "index.html", req).await
}

async fn serve_file(root: &PathBuf, rel_path: &str, mut req: Request<Body>) -> Response {
    // Reset the URI to just the relative path so ServeDir resolves correctly.
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

    let svc = ServeDir::new(root);
    // ServeDir's error type is Infallible — unwrapping is safe.
    match svc.oneshot(req).await {
        Ok(resp) => resp.into_response(),
    }
}

/// Inject the Ikenga artifact bridge (and the design-token stylesheet) into
/// every `text/html` response so host-aware artifacts (per the artifact-studio
/// format defined in the 2026-05-14 Phase 0 plan) can detect they're inside
/// the shell and swap their inline polyfill for the host-resolved runtime (data
/// sources, secret resolution, structured logging). The injected block is, in
/// order: the `<style id="ikenga-tokens">` palette and then the bridge
/// `<script>`. Both ride a single `ARTIFACT_INJECT_MARKER` for idempotency.
///
/// Unlike `inject_iyke_bridge`, this middleware injects **right after the
/// `<head>` opening tag** rather than before `</head>`. The artifact bridge
/// must run before any other script in the document so `window.__ikenga_host__`
/// is set before per-artifact inline polyfills evaluate (their guard:
/// `window.__ikenga_bridge_polyfill__ = window.__ikenga_bridge_polyfill__ || (…)`
/// only takes effect if our IIFE has already populated the polyfill global).
/// Inserting at `</head>` would put the bridge after the inline polyfill,
/// defeating the handoff.
/// Byte offset just past the opening `<head …>` tag, or `None` if the document
/// has no `<head>`. Only a real `<head` element matches: the char after `<head`
/// must be `>`, ASCII whitespace, or `/`, so `<header>` (and any other
/// `<head*` element) is skipped rather than false-matched.
fn find_head_insert(html: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut from = 0;
    while let Some(rel) = html[from..].find("<head") {
        let i = from + rel;
        match bytes.get(i + 5) {
            Some(b'>') | Some(b'/') => return html[i..].find('>').map(|j| i + j + 1),
            Some(c) if c.is_ascii_whitespace() => {
                return html[i..].find('>').map(|j| i + j + 1)
            }
            _ => from = i + 5,
        }
    }
    None
}

async fn inject_artifact_bridge(req: Request<Body>, next: Next) -> Response {
    // Scope to viewer routes only. In prod the same server also handles the
    // shell's frontend dist via the asset-resolver fallback — those HTML
    // responses must NOT receive the artifact bridge.
    let is_viewer_path = req.uri().path().starts_with(VIEWER_PATH_PREFIX);
    let resp = next.run(req).await;
    if !is_viewer_path {
        return resp;
    }
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);
    if !is_html {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    let bytes = match to_bytes(body, HTML_INJECT_MAX_BYTES).await {
        Ok(b) => b,
        Err(_) => return Response::from_parts(parts, Body::empty()),
    };
    let html = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => {
            // Non-UTF8 — return the original bytes untouched; we don't have
            // a safe way to splice without knowing the encoding.
            parts
                .headers
                .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            return Response::from_parts(parts, Body::from(bytes));
        }
    };
    if html.contains(ARTIFACT_INJECT_MARKER) {
        parts
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
        return Response::from_parts(parts, Body::from(bytes));
    }
    // Module scripts are deferred — for the artifact bridge we want
    // *synchronous* execution before the inline polyfill in <head> sees the
    // document, so plain `<script>` (no `type="module"`). The bundle is an
    // IIFE so it's safe to drop into a classic script tag.
    let script = format!(
        "{ARTIFACT_INJECT_MARKER}\n<style id=\"ikenga-tokens\">\n{IKENGA_TOKENS_CSS}\n</style>\n<script>\n{ARTIFACT_BRIDGE_JS}\n</script>\n"
    );
    let mut out = String::with_capacity(html.len() + script.len());
    // Inject right after `<head>` (allowing attributes like `<head class="…">`)
    // — scan for the opening tag then the `>` that closes it. `find_head_insert`
    // rejects `<header>` so we don't splice into the middle of a page.
    if let Some(insert_at) = find_head_insert(html) {
        out.push_str(&html[..insert_at]);
        out.push_str(&script);
        out.push_str(&html[insert_at..]);
    } else if let Some(idx) = html.find("<body") {
        // No <head> — inject just before <body> so it still runs before
        // any body-script.
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
    } else {
        // Bare HTML fragment — prepend.
        out.push_str(&script);
        out.push_str(html);
    }
    let new_bytes = out.into_bytes();
    parts
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(new_bytes.len()));
    Response::from_parts(parts, Body::from(new_bytes))
}

/// Inject the iyke iframe bridge into every `text/html` response so the
/// parent shell can drive the previewed page (DOM snapshot, click, type,
/// console/network capture). Same-origin with the page (the sandbox keeps
/// `allow-same-origin`), so the bridge can read the document and post to
/// `window.parent`.
async fn inject_iyke_bridge(req: Request<Body>, next: Next) -> Response {
    // Same scoping as `inject_artifact_bridge` — only viewer iframes get the
    // iyke iframe bridge; the shell document itself uses the regular host
    // iyke control bridge from `src/lib/iyke/`.
    let is_viewer_path = req.uri().path().starts_with(VIEWER_PATH_PREFIX);
    let resp = next.run(req).await;
    if !is_viewer_path {
        return resp;
    }
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);
    if !is_html {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    let bytes = match to_bytes(body, HTML_INJECT_MAX_BYTES).await {
        Ok(b) => b,
        Err(_) => return Response::from_parts(parts, Body::empty()),
    };
    let html = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => {
            // Non-UTF8 — return the original bytes untouched; we don't have
            // a safe way to splice without knowing the encoding.
            parts
                .headers
                .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            return Response::from_parts(parts, Body::from(bytes));
        }
    };
    if html.contains(IYKE_INJECT_MARKER) {
        parts
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
        return Response::from_parts(parts, Body::from(bytes));
    }
    let script =
        format!("{IYKE_INJECT_MARKER}\n<script type=\"module\">\n{IYKE_BRIDGE_JS}\n</script>\n");
    let mut out = String::with_capacity(html.len() + script.len());
    // Anchor on the OPENING `<head>` tag — NOT `</head>`. A self-contained
    // artifact can inline a library whose source contains an HTML string
    // literal (e.g. DOMPurify ships `'<html xmlns="…"><head></head><body>'`),
    // so the first `</head>` (and the first `<body`) in the byte stream can be
    // *inside that `<script>`*. Splicing the bridge there closes the inlined
    // `<script>` early and leaks the rest of the bundle as visible text. The
    // opening `<head>` reliably precedes any such script content, matching how
    // `inject_artifact_bridge` already anchors. The bridge is `type="module"`
    // (deferred), so head placement still runs after the document parses.
    // `find_head_insert` also rejects `<header>` false-matches.
    if let Some(insert_at) = find_head_insert(html) {
        out.push_str(&html[..insert_at]);
        out.push_str(&script);
        out.push_str(&html[insert_at..]);
    } else if let Some(idx) = html.find("<body") {
        // No <head> — inject just before <body> so it runs before page scripts.
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
    } else {
        // Bare HTML fragment — prepend.
        out.push_str(&script);
        out.push_str(html);
    }
    let new_bytes = out.into_bytes();
    parts
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(new_bytes.len()));
    Response::from_parts(parts, Body::from(new_bytes))
}

async fn inject_security_headers(req: Request<Body>, next: Next) -> Response {
    // The viewer CSP locks down what artifact iframes can do; the shell's own
    // assets need a different (looser) CSP set by Tauri's own asset pipeline.
    // Same scoping as the bridge injectors.
    let is_viewer_path = req.uri().path().starts_with(VIEWER_PATH_PREFIX);
    let mut resp = next.run(req).await;
    if !is_viewer_path {
        return resp;
    }
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(VIEWER_CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // Allow the shell origin (Vite dev or prod localhost-plugin) to embed
    // the iframe. Same-origin policy still applies for DOM access; this is
    // just CORS for asset fetches.
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    resp
}

fn random_token_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    //! Integration tests for the inject middlewares. Mounts a real `ServeDir`
    //! over a tempdir, wires the same middleware stack as `start()`, and uses
    //! `tower::ServiceExt::oneshot` to drive a request without binding a
    //! socket. The assertions cover the load-bearing properties of the
    //! artifact-bridge injection: marker presence, position relative to
    //! `<head>`, ordering against the per-artifact inline polyfill, and
    //! pass-through for non-HTML responses.
    //!
    //! These exist because the only other way to verify the middleware is
    //! to launch a full Tauri shell + viewer iframe, which is not available
    //! in CI and is awkward to drive locally when another shell is running.
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use std::fs;
    use tower::util::ServiceExt;

    /// Build the same router shape as `ViewerServerManager::start` so we
    /// exercise the real middleware ordering. Pass `root` as the only mount.
    fn router_for(token: &str, root: PathBuf) -> Router {
        let mounts: Arc<DashMap<String, Mount>> = Arc::new(DashMap::new());
        mounts.insert(token.to_string(), Mount { root });
        Router::new()
            .route("/__viewer/:token/*path", any(serve_handler))
            .route("/__viewer/:token", any(serve_handler_root))
            .layer(middleware::from_fn(inject_artifact_bridge))
            .layer(middleware::from_fn(inject_iyke_bridge))
            .layer(middleware::from_fn(inject_security_headers))
            .with_state(mounts)
    }

    /// Smallest viable artifact: declares an `id`, the inline polyfill
    /// pattern from the skill template, and the `||` guard that hands off to
    /// the host-injected bridge. Mirrors `hello-world.html` minus the React
    /// noise that's irrelevant to the middleware.
    const TINY_ARTIFACT: &str = r#"<!doctype html>
<html><head>
  <title>Tiny</title>
  <script type="application/json" id="ikenga-manifest">{"id":"tiny"}</script>
  <script>
  window.__ikenga_bridge_polyfill__ = window.__ikenga_bridge_polyfill__ || (function(){return{init:function(){return Promise.resolve({})}}})();
  </script>
</head><body>hi</body></html>
"#;

    /// 1. Bridge bundle is injected into HTML responses.
    /// 2. The marker (and so the bundle) lands AFTER `<head>` and BEFORE the
    ///    inline polyfill — which is the load-bearing ordering: the bundle
    ///    populates `__ikenga_bridge_polyfill__` before the page's inline
    ///    `polyfill = polyfill || (…)` IIFE evaluates, so the IIFE sees a
    ///    truthy left-hand side and short-circuits.
    #[tokio::test]
    async fn artifact_bridge_injected_before_inline_polyfill() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.html"), TINY_ARTIFACT).unwrap();

        let token = "tok_a";
        let app = router_for(token, dir.path().to_path_buf());

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/__viewer/{token}/a.html"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let html = std::str::from_utf8(&body).unwrap();

        assert!(
            html.contains(ARTIFACT_INJECT_MARKER),
            "expected artifact-bridge marker in served HTML, got:\n{html}",
        );

        let head_close = html
            .find("<head")
            .and_then(|i| html[i..].find('>').map(|j| i + j + 1));
        let marker_at = html.find(ARTIFACT_INJECT_MARKER).unwrap();
        let polyfill_at = html.find("__ikenga_bridge_polyfill__ = ").unwrap();

        assert!(
            head_close.unwrap() <= marker_at,
            "bridge marker must land after the <head> opening tag",
        );
        assert!(
            marker_at < polyfill_at,
            "bridge bundle must run before the inline polyfill IIFE so the `|| (…)` guard short-circuits",
        );
    }

    /// The design-token stylesheet is injected into HTML responses exactly
    /// once, carrying the palette custom properties the artifact bridge's
    /// mirrored `data-mode`/`data-theme` attributes key on. Asserts one canary
    /// token (`--bg-base`) rather than the whole sheet so a tokens.css edit
    /// doesn't churn this test.
    #[tokio::test]
    async fn tokens_style_injected_into_html() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.html"), TINY_ARTIFACT).unwrap();

        let token = "tok_t";
        let app = router_for(token, dir.path().to_path_buf());

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/__viewer/{token}/a.html"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        let html = std::str::from_utf8(&body).unwrap();

        assert_eq!(
            html.matches("id=\"ikenga-tokens\"").count(),
            1,
            "tokens <style> must be injected exactly once",
        );
        assert!(
            html.contains("--bg-base"),
            "tokens <style> must carry the palette custom properties",
        );
        // The bridge script must still co-exist in the same injected block.
        assert!(html.contains(ARTIFACT_INJECT_MARKER));
    }

    /// Non-HTML responses (e.g. JSON data files served alongside an
    /// artifact) must pass through unchanged. Without this guard the
    /// middleware would corrupt every static asset.
    #[tokio::test]
    async fn non_html_passes_through() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("data.json"), r#"{"ok":true}"#).unwrap();

        let token = "tok_b";
        let app = router_for(token, dir.path().to_path_buf());

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/__viewer/{token}/data.json"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 4 * 1024).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert_eq!(text, r#"{"ok":true}"#);
        assert!(!text.contains(ARTIFACT_INJECT_MARKER));
    }

    /// If the response already carries the marker, the middleware must not
    /// inject a second copy. Defensive — the layer order shouldn't allow
    /// double-flow today, but two `<script>` blobs in `<head>` would silently
    /// blow up parsing on some artifacts.
    #[tokio::test]
    async fn double_inject_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let pre_injected = format!(
            "<!doctype html><html><head>{ARTIFACT_INJECT_MARKER}\n<script>/* host */</script></head><body>hi</body></html>",
        );
        fs::write(dir.path().join("p.html"), &pre_injected).unwrap();

        let token = "tok_c";
        let app = router_for(token, dir.path().to_path_buf());

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/__viewer/{token}/p.html"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let html = std::str::from_utf8(&body).unwrap();
        assert_eq!(
            html.matches(ARTIFACT_INJECT_MARKER).count(),
            1,
            "marker should appear exactly once after pass-through",
        );
    }

    /// CSP header is present on viewer responses. Picked one canary header
    /// instead of asserting the full policy string so a future widen of the
    /// CSP allowlist doesn't churn this test.
    #[tokio::test]
    async fn csp_header_present() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.html"), TINY_ARTIFACT).unwrap();

        let token = "tok_d";
        let app = router_for(token, dir.path().to_path_buf());

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/__viewer/{token}/a.html"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let csp = resp
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            csp.contains("script-src") && csp.contains("cdn.jsdelivr.net"),
            "CSP must allow the canonical artifact CDN; got: {csp}",
        );
    }
}
