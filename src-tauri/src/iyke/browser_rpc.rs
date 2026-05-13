//! pkg-browser request/reply plumbing.
//!
//! Unlike Iyke's `rpc.rs` (which talks to the shell's main webview by
//! emitting Tauri events the FE listens for), pkg-browser drives a child
//! webview whose page context is an arbitrary external URL. External URLs
//! don't have `window.__TAURI_INTERNALS__` injected, so the child can't
//! `invoke()` back into Rust.
//!
//! Path: the Rust handler evaluates a small JS closure inside the child
//! webview via `WebviewPanesRegistry::eval()`. The closure runs the
//! requested helper from `window.__ikengaPkgBrowser` (installed by
//! `browser_inject.js`) and POSTs the result back to the existing Iyke
//! HTTP server at `/iyke/browser/_reply`. The handler awaits a oneshot
//! keyed by request_id, fulfilled by the reply route. A per-request
//! `oneshot_token` (122-bit UUID) is baked into the eval'd closure and
//! validated by the reply route — partner-site JS can read the global
//! helper, but not in-flight tokens or request_ids (they live only in
//! the eval closure for the lifetime of one fetch).
//!
//! The reply route is **exempted from bearer-token auth** (it's gated by
//! oneshot_token only). Wired as a sibling sub-router in `server.rs`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::pkg::webview::WebviewPanesRegistry;

/// In-page helper script. Inlined at compile time; re-eval'd into each
/// child page on demand (idempotent — see the `__v` guard at the top).
pub const INJECT_SCRIPT: &str = include_str!("browser_inject.js");

#[derive(Clone)]
pub struct BrowserRpc {
    inner: Arc<Mutex<HashMap<String, Slot>>>,
}

struct Slot {
    tx: oneshot::Sender<ReplyEnvelope>,
    oneshot_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReplyEnvelope {
    pub request_id: String,
    pub oneshot_token: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyAck {
    pub ok: bool,
}

impl BrowserRpc {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Send `script_body` (which must end in an expression returning the
    /// result value — see `make_eval` for the wrapping) into the child
    /// webview at `(pkg_id, pane_id)`, wait up to `timeout` for the reply.
    /// Returns the JSON payload on success; an error containing the
    /// browser-side message on failure.
    pub async fn request(
        &self,
        app: &AppHandle,
        panes: &Arc<WebviewPanesRegistry>,
        port: u16,
        pkg_id: &str,
        pane_id: &str,
        timeout: Duration,
        script_body: &str,
    ) -> Result<Value> {
        let request_id = Uuid::new_v4().to_string();
        let oneshot_token = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<ReplyEnvelope>();

        {
            let mut g = self.inner.lock().await;
            g.insert(
                request_id.clone(),
                Slot {
                    tx,
                    oneshot_token: oneshot_token.clone(),
                },
            );
        }

        let eval = make_eval(port, &request_id, &oneshot_token, script_body);
        let eval_result = {
            let (etx, erx) = oneshot::channel::<tauri::Result<()>>();
            let panes_clone = panes.clone();
            let pkg_id_owned = pkg_id.to_string();
            let pane_id_owned = pane_id.to_string();
            let eval_owned = eval.clone();
            app.run_on_main_thread(move || {
                let r = panes_clone
                    .eval(&pkg_id_owned, &pane_id_owned, &eval_owned)
                    .map_err(|e| tauri::Error::Anyhow(e.into()));
                let _ = etx.send(r);
            })
            .map_err(|e| anyhow!("run_on_main_thread for eval: {e}"))?;
            erx.await
                .map_err(|e| anyhow!("main-thread eval channel closed: {e}"))?
        };
        if let Err(e) = eval_result {
            self.inner.lock().await.remove(&request_id);
            return Err(anyhow!("eval into ({pkg_id}, {pane_id}) failed: {e:#}"));
        }

        let reply = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                return Err(anyhow!(
                    "pkg-browser oneshot sender dropped for {request_id}"
                ))
            }
            Err(_) => {
                self.inner.lock().await.remove(&request_id);
                return Err(anyhow!(
                    "pkg-browser request timed out after {}ms (pkg={pkg_id} pane={pane_id})",
                    timeout.as_millis()
                ));
            }
        };

        if !reply.ok {
            return Err(anyhow!(
                "pkg-browser in-page error: {}",
                reply.error.unwrap_or_else(|| "(no message)".to_string())
            ));
        }
        Ok(reply.payload.unwrap_or(Value::Null))
    }

    /// Resolve a pending request from the `/iyke/browser/_reply` route.
    /// Validates `oneshot_token` to defend against partner-site spoofing.
    pub async fn resolve(&self, env: ReplyEnvelope) -> Result<()> {
        let mut g = self.inner.lock().await;
        let Some(slot) = g.remove(&env.request_id) else {
            return Err(anyhow!(
                "no pending pkg-browser request for id {}",
                env.request_id
            ));
        };
        if !constant_time_eq(slot.oneshot_token.as_bytes(), env.oneshot_token.as_bytes()) {
            // Re-insert so a legitimate later reply can still resolve.
            g.insert(
                env.request_id.clone(),
                Slot {
                    tx: slot.tx,
                    oneshot_token: slot.oneshot_token,
                },
            );
            return Err(anyhow!(
                "oneshot_token mismatch for request {}",
                env.request_id
            ));
        }
        let _ = slot.tx.send(env);
        Ok(())
    }
}

impl Default for BrowserRpc {
    fn default() -> Self {
        Self::new()
    }
}

/// Wrap `body` (a JS expression that may be a Promise or a value) in an
/// IIFE that ensures the helper module is installed, runs the body, and
/// posts the result to the reply endpoint. `body` evaluates to either the
/// payload value directly, or a Promise resolving to it.
fn make_eval(port: u16, request_id: &str, oneshot_token: &str, body: &str) -> String {
    let inject = INJECT_SCRIPT;
    let req = json_string(request_id);
    let tok = json_string(oneshot_token);
    format!(
        r#"(async () => {{
  try {{
    {inject}
    const __ipb = window.__ikengaPkgBrowser;
    const __port = {port};
    const __req = {req};
    const __tok = {tok};
    try {{
      const __result = await (async () => {{ return ({body}); }})();
      await __ipb.sendReply(__port, __req, __tok, {{ ok: true, payload: __result }});
    }} catch (__err) {{
      await __ipb.sendReply(__port, __req, __tok, {{ ok: false, error: String(__err && __err.message || __err) }});
    }}
  }} catch (__outer) {{
    try {{
      await fetch('http://127.0.0.1:{port}/iyke/browser/_reply', {{
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ request_id: {req}, oneshot_token: {tok}, ok: false, error: String(__outer && __outer.message || __outer) }}),
      }});
    }} catch (_) {{}}
  }}
}})();"#,
    )
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}
