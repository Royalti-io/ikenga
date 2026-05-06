//! Axum-backed localhost static-file server for the viewer pane (storyboards,
//! rendered Remotion compositions, etc). Each `viewer_serve` call binds to
//! `127.0.0.1:0` with a fresh 32-char hex token; routes are scoped under
//! `/{token}/*path`. Untokenized requests get a 404 so the port can't be
//! probed without the secret.
//!
//! Servers register themselves in `ViewerServerManager` keyed by token; the
//! frontend stops them via `viewer_stop(token)`, which signals a `oneshot` and
//! drops the entry.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use axum::body::{to_bytes, Body};
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use dashmap::DashMap;
use tokio::sync::oneshot;
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

/// Content-Security-Policy injected on every viewer-served response. Allows
/// inline scripts and styles (Claude-generated HTML artifacts use them
/// heavily) but blocks remote `<script src="https://...">` loads — iframe
/// sandbox with `allow-same-origin` doesn't block third-party fetches on its
/// own.
const VIEWER_CSP: &str = "default-src 'self' data: blob:; \
script-src 'self' 'unsafe-inline' 'unsafe-eval'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
font-src 'self' data:; \
media-src 'self' blob:; \
connect-src 'self'";

#[derive(Clone)]
struct ServerState {
    token: String,
    root: PathBuf,
}

struct RunningServer {
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct ViewerServerManager {
    servers: DashMap<String, RunningServer>,
}

impl ViewerServerManager {
    pub fn new() -> Self {
        Self {
            servers: DashMap::new(),
        }
    }

    /// Start a new server. Returns `(url, token)` — url is a fully-qualified
    /// `http://127.0.0.1:{port}/{token}/` prefix the frontend can append paths
    /// to.
    pub async fn serve(self: &Arc<Self>, root: PathBuf) -> Result<(String, String)> {
        let token = random_token_hex(32);
        let state = ServerState {
            token: token.clone(),
            root: root.clone(),
        };

        let app = Router::new()
            .route("/:token/*path", any(serve_handler))
            .route("/:token", any(serve_handler_root))
            .layer(middleware::from_fn(inject_iyke_bridge))
            .layer(middleware::from_fn(inject_security_headers))
            .with_state(Arc::new(state));

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .context("bind viewer listener")?;
        let local_addr = listener.local_addr().context("local_addr")?;

        let (tx, rx) = oneshot::channel::<()>();

        let token_for_url = token.clone();
        let url = format!("http://{}/{}/", local_addr, token_for_url);

        tokio::spawn(async move {
            let server = axum::serve(listener, app.into_make_service())
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                });
            if let Err(e) = server.await {
                log::warn!("viewer server exited: {e}");
            }
        });

        self.servers.insert(
            token.clone(),
            RunningServer {
                shutdown: Some(tx),
            },
        );

        log::info!(
            "viewer server: serving {} at {} (token {})",
            root.display(),
            url,
            &token[..8]
        );
        Ok((url, token))
    }

    pub fn stop(&self, token: &str) -> Result<()> {
        match self.servers.remove(token) {
            Some((_, mut entry)) => {
                if let Some(tx) = entry.shutdown.take() {
                    let _ = tx.send(());
                }
                Ok(())
            }
            None => Err(anyhow!("unknown viewer token")),
        }
    }
}

async fn serve_handler(
    State(state): State<Arc<ServerState>>,
    AxumPath((token, path)): AxumPath<(String, String)>,
    req: Request<Body>,
) -> Response {
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    serve_file(&state.root, &path, req).await
}

async fn serve_handler_root(
    State(state): State<Arc<ServerState>>,
    AxumPath(token): AxumPath<String>,
    req: Request<Body>,
) -> Response {
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    serve_file(&state.root, "index.html", req).await
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
    resp
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn random_token_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}
