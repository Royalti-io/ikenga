//! Iyke axum server. Binds to `127.0.0.1:0`, registers the read + write
//! routes under the bearer-token middleware, and returns
//! `(url, port, shutdown_tx)`. Caller is responsible for keeping the
//! shutdown sender alive — dropping it triggers graceful shutdown.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    http::{HeaderValue, Method as HttpMethod},
    middleware,
    routing::{get, post},
    Extension, Router,
};
use tauri::AppHandle;
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

use super::auth::{require_token, AuthState};
use super::handlers::{
    get_dom, get_iframe_state, get_logs, get_network, get_query_cache, get_state, post_click,
    post_close, post_devtools, post_focus, post_go, post_iframe_message, post_key, post_mode,
    post_open, post_pkg_install, post_pkg_uninstall, post_refresh, post_resize,
    post_screenshot_pane, post_screenshot_window, post_split, post_type, post_wait,
};
use super::pkg_dispatch::pkg_dispatch;
use super::state::IykeState;
use super::IykeRpc;
use crate::commands::ScreenshotPending;
use crate::pkg::registries::IykeRoutesRegistry;

pub async fn serve(
    state: Arc<IykeState>,
    rpc: IykeRpc,
    token: String,
    app_handle: AppHandle,
    screenshot_pending: ScreenshotPending,
    iyke_routes: Arc<IykeRoutesRegistry>,
) -> Result<(String, u16, oneshot::Sender<()>)> {
    let auth_state = Arc::new(AuthState { token });

    let app = Router::new()
        .route("/iyke/state", get(get_state))
        .route("/iyke/go", post(post_go))
        .route("/iyke/mode", post(post_mode))
        .route("/iyke/open", post(post_open))
        .route("/iyke/split", post(post_split))
        .route("/iyke/focus", post(post_focus))
        .route("/iyke/close", post(post_close))
        .route("/iyke/resize", post(post_resize))
        .route("/iyke/refresh", post(post_refresh))
        .route("/iyke/screenshot/window", post(post_screenshot_window))
        .route("/iyke/screenshot/pane", post(post_screenshot_pane))
        // Phase A — runtime inspection + driving.
        .route("/iyke/dom", get(get_dom))
        .route("/iyke/logs", get(get_logs))
        .route("/iyke/network", get(get_network))
        .route("/iyke/query-cache", get(get_query_cache))
        .route("/iyke/click", post(post_click))
        .route("/iyke/type", post(post_type))
        .route("/iyke/key", post(post_key))
        .route("/iyke/wait", post(post_wait))
        .route("/iyke/devtools", post(post_devtools))
        .route("/iyke/pkg/install", post(post_pkg_install))
        .route("/iyke/pkg/uninstall", post(post_pkg_uninstall))
        .route("/iyke/iframe-state", get(get_iframe_state))
        .route("/iyke/iframe-message", post(post_iframe_message))
        // Catch-all for package-installed routes. The dispatcher reads the
        // method+path off the request and consults `IykeRoutesRegistry`.
        .route("/pkg/*path", get(pkg_dispatch).post(pkg_dispatch))
        .layer(middleware::from_fn_with_state(
            auth_state.clone(),
            require_token,
        ))
        .layer(Extension(state))
        .layer(Extension(rpc))
        .layer(Extension(auth_state))
        .layer(Extension(app_handle))
        .layer(Extension(screenshot_pending))
        .layer(Extension(iyke_routes))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([HttpMethod::GET, HttpMethod::POST, HttpMethod::OPTIONS])
                .allow_headers(Any),
        );

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .context("bind iyke listener")?;
    let local_addr = listener.local_addr().context("local_addr")?;
    let port = local_addr.port();
    let url = format!("http://{}", local_addr);

    let (tx, rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let server = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            });
        if let Err(e) = server.await {
            log::warn!("iyke server exited: {e}");
        }
    });

    Ok((url, port, tx))
}
