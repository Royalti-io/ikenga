//! pkg MCP tool routing. The iframe host bridge calls
//! `pkg_mcp_call(pkgId, tool, args)` when an MCP App fires `tools/call`.
//!
//! Flow:
//! 1. Look up the package's install path from the kernel's in-memory map.
//! 2. Reload the manifest from `<install_path>/manifest.json` to get the
//!    current `mcp` entries (cheap file read; lifecycle ops are rare so
//!    we avoid duplicating manifest state in the kernel).
//! 3. Pick the MCP server entry (single-server packages auto-select).
//! 4. Spawn the server, run the MCP handshake, dispatch the tool call,
//!    return the JSON-RPC `result` payload.
//!
//! Errors are surfaced as `{ ok: false, error }` rather than Tauri command
//! errors so the iframe can render them as MCP tool errors instead of the
//! whole bridge tearing down.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::commands::pkg::KernelState;
use crate::pkg::manifest::Package;
use crate::pkg::mcp_runtime;
use crate::pkg::SidecarSupervisor;

/// State wrapper for the kernel-owned sidecar supervisor. Stored alongside
/// `KernelState` so commands can dispatch long-lived MCP calls without going
/// through the kernel snapshot.
pub struct SidecarSupervisorState(pub Arc<SidecarSupervisor>);

#[derive(Serialize)]
pub struct PkgMcpCallResult {
    pub ok: bool,
    pub error: Option<String>,
    pub result: Option<Value>,
}

#[tauri::command]
pub async fn pkg_mcp_call(
    kernel: State<'_, KernelState>,
    supervisor: State<'_, SidecarSupervisorState>,
    pkg_id: String,
    tool: String,
    args: Value,
) -> Result<PkgMcpCallResult, String> {
    let install_path = match kernel.0.installed_path(&pkg_id) {
        Some(p) => p,
        None => {
            return Ok(PkgMcpCallResult {
                ok: false,
                error: Some(format!("pkg `{pkg_id}` is not installed")),
                result: None,
            });
        }
    };

    let pkg = match Package::load(&install_path) {
        Ok(p) => p,
        Err(e) => {
            return Ok(PkgMcpCallResult {
                ok: false,
                error: Some(format!("reload manifest: {e:#}")),
                result: None,
            });
        }
    };
    if pkg.manifest.mcp.is_empty() {
        return Ok(PkgMcpCallResult {
            ok: false,
            error: Some(format!("pkg `{pkg_id}` declares no mcp servers")),
            result: None,
        });
    }

    let server = match mcp_runtime::pick_server(&pkg.manifest.mcp, "") {
        Ok(s) => s,
        Err(e) => {
            return Ok(PkgMcpCallResult {
                ok: false,
                error: Some(format!("{e:#}")),
                result: None,
            });
        }
    };

    let lifecycle = if server.is_long_lived() { "long-lived" } else { "per-call" };
    log::info!(
        "[pkg_mcp_call] pkg={pkg_id} tool={tool} server={} cmd={} lifecycle={lifecycle}",
        server.name,
        server.command
    );

    let result = if server.is_long_lived() {
        // Supervised path: reuse the kernel-managed long-lived child.
        match supervisor.0.get(&pkg_id) {
            Some(sup) => sup.call_tool(&tool, args).await,
            None => Err(anyhow::anyhow!(
                "pkg `{pkg_id}` declares lifecycle=long-lived but supervisor has no entry — \
                 install may have failed or the child is in shutdown"
            )),
        }
    } else {
        // Per-call path: spawn-handshake-call-reap on every invocation.
        mcp_runtime::call_tool(&install_path, server, &tool, args).await
    };

    match result {
        Ok(result) => Ok(PkgMcpCallResult {
            ok: true,
            error: None,
            result: Some(result),
        }),
        Err(e) => Ok(PkgMcpCallResult {
            ok: false,
            error: Some(format!("{e:#}")),
            result: None,
        }),
    }
}

// ── Operator action: restart a supervised pkg ────────────────────────────
//
// Surfaced in the kernel-status UI as the "Restart" button next to a
// Blocked / Crashed / Parked entry. Sends a kick to break out of any
// pending sleep and (for Parked entries) re-launches the supervisor task.

#[tauri::command]
pub fn pkg_supervisor_restart(
    supervisor: State<'_, SidecarSupervisorState>,
    pkg_id: String,
) -> Result<bool, String> {
    supervisor
        .0
        .restart(&pkg_id)
        .map_err(|e| format!("{e:#}"))
}

// ── Debug-only: bind/release a port for smoke tests ──────────────────────
//
// The /iframe-mount-smoke?phase=storyboard recovery step needs to
// pre-occupy port 3105 so the supervised storyboard sidecar's child sees
// EADDRINUSE. We expose a tiny token-based holder so the smoke can also
// release the port and observe recovery. Strictly a debug-build affair.

#[cfg(debug_assertions)]
mod dev_port {
    use std::collections::HashMap;
    use std::net::TcpListener;
    use std::sync::{Mutex, OnceLock};

    static HELD: OnceLock<Mutex<(u64, HashMap<u64, TcpListener>)>> = OnceLock::new();

    fn held() -> &'static Mutex<(u64, HashMap<u64, TcpListener>)> {
        HELD.get_or_init(|| Mutex::new((0, HashMap::new())))
    }

    pub fn bind(port: u16) -> Result<u64, String> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
        // Listener does NOT need to accept; just holding it is enough to
        // hold the port. Mark non-blocking so any stray accept is cheap.
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking: {e}"))?;
        let mut g = held().lock().map_err(|_| "dev_port poisoned")?;
        g.0 += 1;
        let token = g.0;
        g.1.insert(token, listener);
        Ok(token)
    }

    pub fn release(token: u64) -> bool {
        let mut g = match held().lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        g.1.remove(&token).is_some()
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn dev_bind_port(port: u16) -> Result<u64, String> {
    dev_port::bind(port)
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn dev_release_port(token: u64) -> Result<bool, String> {
    Ok(dev_port::release(token))
}

// Release-build stubs so the smoke route can still compile against a
// stable typed wrapper (it gates the dev-only call paths behind
// import.meta.env.DEV anyway).
#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn dev_bind_port(_port: u16) -> Result<u64, String> {
    Err("dev_bind_port disabled in release builds".into())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn dev_release_port(_token: u64) -> Result<bool, String> {
    Err("dev_release_port disabled in release builds".into())
}
