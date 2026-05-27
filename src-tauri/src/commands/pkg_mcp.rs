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

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::commands::projects::resolve_project_env_ctx;
use crate::pkg::manifest::Package;
use crate::pkg::mcp_runtime;
use crate::pkg::SidecarSupervisor;

/// State wrapper for the kernel-owned sidecar supervisor. Stored alongside
/// `KernelState` so commands can dispatch long-lived MCP calls without going
/// through the kernel snapshot. Clone-friendly so the iyke bridge can
/// layer it as an axum `Extension` (Phase 5 `iyke_mcp_list` /
/// `iyke_mcp_restart`).
#[derive(Clone)]
pub struct SidecarSupervisorState(pub Arc<SidecarSupervisor>);

/// Phase 5 helper: build the env overlay for an MCP child spawn. Resolves
/// the pkg's scope from the kernel snapshot and fetches the matching
/// project's root. Workspace-scoped pkgs (project_id=None) fall back to the
/// active project. Returns an empty map if the lookups all miss — callers
/// just don't inject the env (parity with pre-Phase-5 behavior).
async fn build_pkg_env_overlay(
    db: &Arc<PaDb>,
    pkg_id: &str,
    kernel: &crate::pkg::Kernel,
    app: &AppHandle,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pkg_project = kernel.installed_summary(pkg_id).and_then(|s| s.project_id);
    let Ok(pool) = db.ensure_pool().await else {
        return env;
    };
    let (id, root) = resolve_project_env_ctx(&pool, pkg_project.as_deref()).await;
    // Phase 7: layer workspace + project `.env` files. Map order doesn't
    // matter for the consumer (HashMap insertion order is irrelevant);
    // we add layered first, then overwrite with IKENGA_PROJECT_* so the
    // kernel-supplied identity always wins over `.env` declarations.
    {
        use tauri::Manager;
        let app_data = app.path().app_data_dir().ok();
        let ws_env = app_data.as_ref().map(|d| d.join("workspace.env"));
        let root_path = root.as_ref().map(std::path::PathBuf::from);
        let layered = crate::env_files::build_layered_env(ws_env.as_deref(), root_path.as_deref());
        for (k, v) in layered {
            env.insert(k, v);
        }
    }
    if let Some(id) = id {
        env.insert("IKENGA_PROJECT_ID".to_string(), id);
    }
    if let Some(root) = root {
        env.insert("IKENGA_PROJECT_ROOT".to_string(), root);
    }
    env
}

#[derive(Serialize)]
pub struct PkgMcpCallResult {
    pub ok: bool,
    pub error: Option<String>,
    pub result: Option<Value>,
}

#[tauri::command]
pub async fn pkg_mcp_call(
    app: AppHandle,
    kernel: State<'_, KernelState>,
    supervisor: State<'_, SidecarSupervisorState>,
    db: State<'_, Arc<PaDb>>,
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

    // Phase 9: trust gating. Both per-call AND supervised tools/call paths
    // are gated here — the supervised path's child still boots (lifecycle
    // events keep flowing), but every tools/call against an untrusted pkg
    // returns the structured `trust_required` error so calling agents can
    // surface "approve via Settings → Pkgs". Built-ins and pkgs without
    // sensitive perms are auto-trusted; this branch only fires for
    // sideloaded / registry pkgs that declared shell.execute or fs.write
    // outside their $pkg_data sandbox.
    let trust_state = {
        use tauri::Manager;
        let app_data = match app.path().app_data_dir() {
            Ok(p) => p,
            Err(e) => {
                return Ok(PkgMcpCallResult {
                    ok: false,
                    error: Some(format!("app_data_dir: {e}")),
                    result: None,
                });
            }
        };
        let source = kernel
            .0
            .installed_summary(&pkg_id)
            .map(|s| s.source)
            .unwrap_or(crate::pkg::source::InstallSource::Local {
                path: install_path.display().to_string(),
            });
        let pool = match db.ensure_pool().await {
            Ok(p) => p,
            Err(e) => {
                return Ok(PkgMcpCallResult {
                    ok: false,
                    error: Some(format!("db pool: {e}")),
                    result: None,
                });
            }
        };
        match crate::pkg::trust::evaluate(&pool, &pkg, &source, &app_data).await {
            Ok(s) => s,
            Err(e) => {
                return Ok(PkgMcpCallResult {
                    ok: false,
                    error: Some(format!("trust evaluate: {e:#}")),
                    result: None,
                });
            }
        }
    };
    if !trust_state.is_allowed() {
        return Ok(PkgMcpCallResult {
            ok: false,
            error: Some(format!(
                "{}",
                crate::pkg::trust::trust_required_error(&pkg_id)
            )),
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

    let lifecycle = if server.is_long_lived() {
        "long-lived"
    } else {
        "per-call"
    };
    log::info!(
        "[pkg_mcp_call] pkg={pkg_id} tool={tool} server={} cmd={} lifecycle={lifecycle}",
        server.name,
        server.command
    );

    let result = if server.is_long_lived() {
        // Supervised path: reuse the kernel-managed long-lived child. The
        // env vars for IKENGA_PROJECT_ID/ROOT were applied at spawn time
        // by the supervisor; we don't re-inject them per call (workspace
        // pkgs spawned under project A keep that env even when the user
        // switches to project B — known limitation, see Phase 5 doc).
        match supervisor.0.get(&pkg_id) {
            Some(sup) => sup.call_tool(&tool, args).await,
            None => Err(anyhow::anyhow!(
                "pkg `{pkg_id}` declares lifecycle=long-lived but supervisor has no entry — \
                 install may have failed or the child is in shutdown"
            )),
        }
    } else {
        // Per-call path: spawn-handshake-call-reap on every invocation. We
        // inject IKENGA_PROJECT_ID/ROOT fresh on every call so it always
        // reflects the *current* active project (workspace pkgs) or its
        // own (project pkgs).
        let extra_env = build_pkg_env_overlay(&db, &pkg_id, &kernel.0, &app).await;
        // Runtime-ACL phase: pass the pkg's shell.execute allowlist + a DB
        // pool for audit. Pool is best-effort — if we can't acquire it,
        // skip the audit and let the deny still fire.
        let audit_pool = db.ensure_pool().await.ok();
        mcp_runtime::call_tool(
            &install_path,
            server,
            &tool,
            args,
            &extra_env,
            &pkg_id,
            &pkg.manifest.permissions.shell_execute,
            audit_pool.as_ref(),
        )
        .await
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
    supervisor.0.restart(&pkg_id).map_err(|e| format!("{e:#}"))
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
