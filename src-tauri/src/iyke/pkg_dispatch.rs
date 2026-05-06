//! Catch-all dispatcher for `/pkg/*` routes. Reads the request's method +
//! full URI path, looks the pair up in `IykeRoutesRegistry`, and runs the
//! corresponding handler.
//!
//! Auth: this handler is mounted under the same `require_token` middleware
//! as the rest of the iyke routes — packages don't get to bypass the bearer
//! token check.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::Request,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Extension,
};
use tauri::{AppHandle, Emitter};

use crate::pkg::registries::iyke_routes::{Handler, IykeRoutesRegistry};

pub async fn pkg_dispatch(
    Extension(routes): Extension<Arc<IykeRoutesRegistry>>,
    Extension(app): Extension<AppHandle>,
    req: Request,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    let entry = match routes.resolve(method.as_str(), &path) {
        Some(e) => e,
        None => return (StatusCode::NOT_FOUND, format!("no pkg route: {method} {path}")).into_response(),
    };

    // Read body once so handlers can choose to ignore or use it.
    let body_bytes = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("read body: {e}")).into_response(),
    };

    match entry.handler {
        Handler::Echo => (StatusCode::OK, body_bytes).into_response(),

        Handler::EventEmit { name } => {
            let event_name = format!("pkg://{name}");
            // Try to forward as JSON; fall back to bytes-as-string if not.
            let payload: serde_json::Value = serde_json::from_slice(&body_bytes)
                .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&body_bytes).into_owned()));
            if let Err(e) = app.emit(&event_name, payload) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("emit `{event_name}` failed: {e}"),
                )
                    .into_response();
            }
            (StatusCode::ACCEPTED, format!("emitted {event_name}")).into_response()
        }

        Handler::Sidecar { name, subcommand } => {
            // Deferred: needs SidecarsRegistry.resolve(name) → bin path,
            // plus a streaming stdin/stdout spawn helper. For now return 501
            // so a route declaring this handler doesn't silently 404.
            let _ = (name, subcommand, body_bytes);
            (
                StatusCode::NOT_IMPLEMENTED,
                "sidecar handler not yet wired",
            )
                .into_response()
        }
    }
}

async fn read_body(req: Request) -> anyhow::Result<Bytes> {
    use axum::body::to_bytes;
    let (_parts, body) = req.into_parts();
    Ok(to_bytes(body, 4 * 1024 * 1024).await?)
}

// Compile-time check that the supported method set matches what we
// register in server.rs. If you add PUT/DELETE later, also list them here
// and add a route layer in server.rs.
#[allow(dead_code)]
const _SUPPORTED_METHODS: &[Method] = &[Method::GET, Method::POST];
