//! MCP bridge endpoints — let the iyke CLI / mcp-iyke list resolved MCP
//! servers per project and restart wedged supervised children.
//!
//! Phase 5 of the projects-first-class plan. Wraps:
//!   - `claude::discovery::AssetTree.mcps` (the 4-tier merged set) for the
//!     full per-project view, including per-call (on-demand) entries that
//!     never become supervised children.
//!   - `pkg::SidecarSupervisor::statuses()` for live state (Running /
//!     Parked / Crashed / Blocked) on long-lived entries.
//!
//! Restart granularity is `pkg_id` (the supervisor's keying unit). A pkg
//! that declares multiple long-lived MCP servers restarts all of them
//! together — matches today's spawn-on-register semantics.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::claude::discovery;
use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::commands::pkg_mcp::SidecarSupervisorState;
use crate::commands::projects::get_active_project_id;
use crate::pkg::lifecycle::SidecarStatus;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, String) {
    (status, msg.into())
}

fn map_err(e: String) -> (StatusCode, String) {
    let lower = e.to_lowercase();
    if lower.contains("not found") {
        err(StatusCode::NOT_FOUND, e)
    } else if lower.contains("invalid") || lower.contains("archived") {
        err(StatusCode::BAD_REQUEST, e)
    } else {
        err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Serialize)]
pub struct McpEntryView {
    /// Server name as it appears in `mcpServers` / `servers`. Phase 4's
    /// discovery dedupes per-name across tiers; this is the resolved
    /// winner (after pin resolution would apply at session-spawn time).
    pub name: String,
    /// pkg id when sourced from a pkg manifest; `"personal"` for
    /// `~/.claude/`-tier entries; `"project:<id>"` for project-root
    /// `.mcp.json` entries.
    pub provider: String,
    /// 4-tier source: `personal | workspace_pkg | project | project_pkg`.
    pub tier: String,
    /// Transport hint from `claude_config::McpEntry` — `"stdio"`, `"http"`,
    /// `"sse"`, or `"unknown"`. Re-parsed lazily here so list reads stay
    /// cheap; absent when re-parsing fails.
    pub transport: Option<String>,
    /// Lifecycle classification:
    ///   - `"long-lived"` for supervised pkg MCPs (state matches
    ///     `SupervisedSidecar.state`).
    ///   - `"per-call"` for pkg MCPs spawned per-tool-call.
    ///   - `"on-demand"` for tier-1/2/3 entries that claude spawns itself
    ///     (no supervisor presence). State is always `"on-demand"`.
    pub lifecycle: String,
    pub state: String,
    /// Source file path (settings.json / .mcp.json) for re-parsing the raw
    /// entry. Useful for the FE detail popover; not load-bearing for the
    /// MCP tools.
    pub path: String,
    /// Last error string from the supervisor, if any. Only populated for
    /// long-lived entries in Crashed / Blocked / Parked.
    pub last_error: Option<String>,
}

pub async fn get_mcp_list(
    Extension(db): Extension<Arc<PaDb>>,
    Extension(app): Extension<AppHandle>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // The kernel + supervisor are constructed in `lib.rs::setup` after
    // `iyke::start` (the iyke bridge has to be up before the kernel runs
    // boot-replay so installs can hit the registered endpoints). We pull
    // them through `app.state()` rather than threading them as Extension
    // layers, which avoids a setup-order constraint between the two.
    let kernel_state = app.state::<KernelState>();
    let sup_state = app.state::<SidecarSupervisorState>();
    let pool = db.ensure_pool().await.map_err(map_err)?;
    let project_id = match q.project_id {
        Some(id) => id,
        None => get_active_project_id(&pool).await.map_err(map_err)?,
    };

    // Tier 1-4 merged view.
    let tree = discovery::discover(&project_id, &pool, &app)
        .await
        .map_err(map_err)?;

    // Index supervised state by pkg_id for join.
    let statuses: HashMap<String, SidecarStatus> = sup_state
        .0
        .statuses()
        .into_iter()
        .map(|s| (s.pkg_id.clone(), s))
        .collect();

    // Reload each pkg's manifest from disk so we can tag long-lived vs
    // per-call MCP entries. `InstalledSummary` doesn't carry the manifest
    // JSON in-memory; cheap file read is fine here — listing MCPs is rare.
    let installed = kernel_state.0.list_installed();
    let mut pkg_mcp_lifecycle: HashMap<(String, String), &'static str> = HashMap::new();
    for s in &installed {
        let pkg = match crate::pkg::manifest::Package::load(std::path::Path::new(&s.install_path)) {
            Ok(p) => p,
            Err(_) => continue,
        };
        for entry in &pkg.manifest.mcp {
            let lc = if entry.is_long_lived() {
                "long-lived"
            } else {
                "per-call"
            };
            pkg_mcp_lifecycle.insert((s.id.clone(), entry.name.clone()), lc);
        }
    }

    let mut entries: Vec<McpEntryView> = Vec::new();
    for (name, sources) in tree.mcps {
        // Surface every source separately (the FE wants to see conflicts).
        // Resolution to a single winner is the Ngwa/Ọba config UI's job
        // (`commands/claude_config.rs`, via `resolve_preferred`) — this
        // endpoint documents the input, not the resolved output. Since D-13
        // no session-spawn-time resolution happens at all: spawned children
        // use claude's own native MCP discovery.
        for src in sources {
            let lifecycle_key = (src.provider.clone(), name.clone());
            let lifecycle = pkg_mcp_lifecycle
                .get(&lifecycle_key)
                .copied()
                .unwrap_or("on-demand");
            let (state, last_error) = if lifecycle == "long-lived" {
                match statuses.get(&src.provider) {
                    Some(s) => (s.state.to_string(), s.last_err.clone()),
                    None => ("not-started".to_string(), None),
                }
            } else {
                (lifecycle.to_string(), None)
            };
            entries.push(McpEntryView {
                name: name.clone(),
                provider: src.provider.clone(),
                tier: src.tier.as_str().to_string(),
                transport: reparse_transport(&src.path, &name),
                lifecycle: lifecycle.to_string(),
                state,
                path: src.path.clone(),
                last_error,
            });
        }
    }

    Ok(Json(json!({ "mcps": entries })))
}

/// Best-effort: re-parse the settings/.mcp.json file pointed at by
/// `AssetSource.path` and return the transport string from the matching
/// `mcpServers.<name>` entry. Returns `None` on any failure — non-fatal.
fn reparse_transport(path: &str, name: &str) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let entry = json
        .get("mcpServers")
        .or_else(|| json.get("servers"))?
        .as_object()?
        .get(name)?;
    if let Some(t) = entry.get("type").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    if entry.get("url").is_some() {
        return Some("http".to_string());
    }
    if entry.get("command").is_some() {
        return Some("stdio".to_string());
    }
    None
}

#[derive(Deserialize)]
pub struct RestartBody {
    pub pkg_id: String,
}

pub async fn post_mcp_restart(
    Extension(app): Extension<AppHandle>,
    Json(body): Json<RestartBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.pkg_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "pkg_id is required"));
    }
    let sup_state = app.state::<SidecarSupervisorState>();
    let dispatched = sup_state.0.restart(&body.pkg_id).map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("restart failed: {e:#}"),
        )
    })?;
    if !dispatched {
        return Err(err(
            StatusCode::NOT_FOUND,
            format!(
                "pkg `{}` is not supervised (per-call or workspace-parked)",
                body.pkg_id
            ),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}
