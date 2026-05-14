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
    pub async fn start(self: &Arc<Self>) -> Result<u16> {
        if let Some(p) = self.bound_port() {
            return Ok(p);
        }

        let port: u16 = std::env::var("IKENGA_VIEWER_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_VIEWER_PORT);

        let mounts = self.mounts.clone();
        let app = Router::new()
            .route("/__viewer/:token/*path", any(serve_handler))
            .route("/__viewer/:token", any(serve_handler_root))
            // Health probe so the FE can confirm the server is up before
            // mounting an iframe (avoids a flash of "viewer offline").
            .route("/__viewer-health", any(health_handler))
            .layer(middleware::from_fn(inject_iyke_bridge))
            .layer(middleware::from_fn(inject_security_headers))
            .with_state(mounts);

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
            .await
            .with_context(|| format!("bind viewer listener on 127.0.0.1:{port}"))?;
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

/// Inject the iyke iframe bridge into every `text/html` response so the
/// parent shell can drive the previewed page (DOM snapshot, click, type,
/// console/network capture). Same-origin with the page (the sandbox keeps
/// `allow-same-origin`), so the bridge can read the document and post to
/// `window.parent`.
async fn inject_iyke_bridge(req: Request<Body>, next: Next) -> Response {
    let resp = next.run(req).await;
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
            parts.headers.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from(bytes.len()),
            );
            return Response::from_parts(parts, Body::from(bytes));
        }
    };
    if html.contains(IYKE_INJECT_MARKER) {
        parts.headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from(bytes.len()),
        );
        return Response::from_parts(parts, Body::from(bytes));
    }
    let script = format!(
        "{IYKE_INJECT_MARKER}\n<script type=\"module\">\n{IYKE_BRIDGE_JS}\n</script>\n"
    );
    let mut out = String::with_capacity(html.len() + script.len());
    if let Some(idx) = html.find("</head>") {
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
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
    parts.headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(new_bytes.len()),
    );
    Response::from_parts(parts, Body::from(new_bytes))
}

async fn inject_security_headers(req: Request<Body>, next: Next) -> Response {
    let mut resp = next.run(req).await;
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
