use std::sync::Arc;
use std::time::Duration;

use axum::{extract::Json as JsonBody, http::StatusCode, Extension, Json};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::iyke::state::IykeState;
use crate::pty::{PtyManager, TerminalAuditEntry, TerminalDescriptor};
use crate::window::descriptor::{WindowDescriptor, WindowKind};
use crate::window::registry::WindowRegistry;

fn err(status: StatusCode, message: impl Into<String>) -> (StatusCode, String) {
    (status, message.into())
}

#[derive(Clone, Serialize)]
pub struct IykeWindowInfo {
    pub label: String,
    pub kind: WindowKind,
    pub surface_set: Vec<String>,
    pub project_id: Option<String>,
    pub layout_key: String,
    pub panes: Option<Value>,
}

impl IykeWindowInfo {
    pub fn from_descriptor(descriptor: WindowDescriptor, panes: Option<Value>) -> Self {
        Self {
            label: descriptor.label,
            kind: descriptor.kind,
            surface_set: descriptor.surface_set,
            project_id: descriptor.project_id,
            layout_key: descriptor.layout_key,
            panes,
        }
    }
}

#[derive(Deserialize)]
pub struct TerminalTargetBody {
    pub terminal: String,
}

#[derive(Deserialize)]
pub struct TerminalLabelBody {
    pub terminal: String,
    pub label: Option<String>,
}

#[derive(Deserialize)]
pub struct TerminalLeaseBody {
    pub terminal: String,
    pub agent_id: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
}

#[derive(Deserialize)]
pub struct TerminalLeaseReleaseBody {
    pub terminal: String,
    pub token: String,
}

#[derive(Deserialize)]
pub struct TerminalWaitBody {
    pub terminal: String,
    #[serde(default)]
    pub r#match: Option<String>,
    #[serde(default)]
    pub until_idle_ms: Option<u64>,
    #[serde(default)]
    pub after: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub raw: bool,
}

#[derive(Serialize)]
pub struct TerminalWaitResponse {
    pub satisfied: bool,
    pub matched: bool,
    pub idle: bool,
    pub timed_out: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub text: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub available_start_offset: u64,
    pub truncated: bool,
}

#[derive(Deserialize)]
pub struct TabActivateBody {
    pub pane: String,
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub terminal: Option<String>,
}

pub fn enrich_terminals(
    terminals: &mut [TerminalDescriptor],
    panes: Option<&Value>,
    windows: &[WindowDescriptor],
) {
    if let Some(leaves) = panes
        .and_then(|panes| panes.get("leaves"))
        .and_then(Value::as_array)
    {
        for leaf in leaves {
            let pane_id = leaf.get("id").and_then(Value::as_str).unwrap_or_default();
            let focused_leaf = leaf
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let active_index = leaf
                .get("activeTabIdx")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if let Some(tabs) = leaf.get("tabs").and_then(Value::as_array) {
                for (index, tab) in tabs.iter().enumerate() {
                    let terminal_id = tab.get("terminalId").and_then(Value::as_str);
                    let pty_id = tab.get("ptyId").and_then(Value::as_str);
                    if let Some(terminal) = terminals.iter_mut().find(|terminal| {
                        pty_id == Some(terminal.pty_id.as_str())
                            || terminal_id == Some(terminal.terminal_id.as_str())
                    }) {
                        if !pane_id.is_empty() && !terminal.pane_ids.iter().any(|id| id == pane_id)
                        {
                            terminal.pane_ids.push(pane_id.to_string());
                        }
                        if !terminal.window_labels.iter().any(|label| label == "main") {
                            terminal.window_labels.push("main".to_string());
                        }
                        if index == active_index {
                            terminal.mounted = true;
                            terminal.focused |= focused_leaf;
                        }
                    }
                }
            }
        }
    }
    for window in windows {
        for surface in &window.surface_set {
            if let Some(pty_id) = surface.strip_prefix("terminal:") {
                if let Some(terminal) = terminals
                    .iter_mut()
                    .find(|terminal| terminal.pty_id == pty_id)
                {
                    terminal.mounted = true;
                    if !terminal
                        .window_labels
                        .iter()
                        .any(|label| label == &window.label)
                    {
                        terminal.window_labels.push(window.label.clone());
                    }
                }
            }
        }
    }
}

pub async fn get_terminals(
    Extension(manager): Extension<Arc<PtyManager>>,
    Extension(state): Extension<Arc<IykeState>>,
    Extension(app): Extension<AppHandle>,
) -> Json<Vec<TerminalDescriptor>> {
    let panes = state.snapshot().await.panes;
    let registry = app.state::<WindowRegistry>();
    let windows = registry.list_live(&app);
    let mut terminals = manager.list_terminals();
    enrich_terminals(&mut terminals, panes.as_ref(), &windows);
    Json(terminals)
}

pub async fn post_terminal_get(
    Extension(manager): Extension<Arc<PtyManager>>,
    JsonBody(body): JsonBody<TerminalTargetBody>,
) -> Result<Json<TerminalDescriptor>, (StatusCode, String)> {
    manager
        .list_terminals()
        .into_iter()
        .find(|terminal| {
            terminal.terminal_id == body.terminal
                || terminal.pty_id == body.terminal
                || terminal.label.as_deref() == Some(body.terminal.as_str())
        })
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "terminal not found"))
}

pub async fn post_terminal_label(
    Extension(manager): Extension<Arc<PtyManager>>,
    JsonBody(body): JsonBody<TerminalLabelBody>,
) -> Result<Json<TerminalDescriptor>, (StatusCode, String)> {
    manager
        .set_label(&body.terminal, body.label)
        .map(Json)
        .map_err(|error| err(StatusCode::BAD_REQUEST, error.to_string()))
}

pub async fn post_terminal_lease_acquire(
    Extension(manager): Extension<Arc<PtyManager>>,
    JsonBody(body): JsonBody<TerminalLeaseBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.agent_id.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "agent_id must not be empty"));
    }
    let (token, expires_at) = manager
        .acquire_lease(&body.terminal, body.agent_id, body.ttl_ms.unwrap_or(60_000))
        .map_err(|error| err(StatusCode::CONFLICT, error.to_string()))?;
    Ok(Json(json!({ "token": token, "expires_at": expires_at })))
}

pub async fn post_terminal_lease_release(
    Extension(manager): Extension<Arc<PtyManager>>,
    JsonBody(body): JsonBody<TerminalLeaseReleaseBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    manager
        .release_lease(&body.terminal, &body.token)
        .map_err(|error| err(StatusCode::CONFLICT, error.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn get_terminal_audit(
    Extension(manager): Extension<Arc<PtyManager>>,
) -> Json<Vec<TerminalAuditEntry>> {
    Json(manager.audit_entries())
}

pub async fn post_terminal_wait(
    Extension(manager): Extension<Arc<PtyManager>>,
    JsonBody(body): JsonBody<TerminalWaitBody>,
) -> Result<Json<TerminalWaitResponse>, (StatusCode, String)> {
    if body.r#match.is_none() == body.until_idle_ms.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "set exactly one of: match, until_idle_ms",
        ));
    }
    let pattern = body
        .r#match
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(|error| err(StatusCode::BAD_REQUEST, format!("invalid regex: {error}")))?;
    let timeout_ms = body.timeout_ms.unwrap_or(10_000).clamp(1, 300_000);
    let (snapshot, matched, idle, exit_code) = manager
        .wait_for_output(
            &body.terminal,
            body.after.unwrap_or(0),
            pattern.as_ref(),
            body.until_idle_ms,
            Duration::from_millis(timeout_ms),
        )
        .await
        .map_err(|error| err(StatusCode::NOT_FOUND, error.to_string()))?;
    let text = if body.raw {
        String::from_utf8_lossy(&snapshot.data).into_owned()
    } else {
        String::from_utf8_lossy(&strip_ansi_escapes::strip(&snapshot.data)).into_owned()
    };
    let exited = exit_code.is_some();
    let satisfied = matched || idle;
    Ok(Json(TerminalWaitResponse {
        satisfied,
        matched,
        idle,
        timed_out: !satisfied && !exited,
        exited,
        exit_code,
        text,
        start_offset: snapshot.start_offset,
        end_offset: snapshot.end_offset,
        available_start_offset: snapshot.available_start_offset,
        truncated: snapshot.truncated,
    }))
}

pub async fn get_windows(
    Extension(app): Extension<AppHandle>,
    Extension(state): Extension<Arc<IykeState>>,
) -> Json<Vec<IykeWindowInfo>> {
    let registry = app.state::<WindowRegistry>();
    let panes = state.snapshot().await.panes;
    let mut windows = vec![IykeWindowInfo::from_descriptor(
        WindowDescriptor {
            label: "main".to_string(),
            kind: WindowKind::Primary,
            surface_set: Vec::new(),
            project_id: None,
            layout_key: "main".to_string(),
        },
        panes,
    )];
    windows.extend(
        registry
            .list_live(&app)
            .into_iter()
            .map(|descriptor| IykeWindowInfo::from_descriptor(descriptor, None)),
    );
    Json(windows)
}

pub async fn post_tab_activate(
    Extension(app): Extension<AppHandle>,
    JsonBody(body): JsonBody<TabActivateBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.index.is_none() == body.terminal.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "set exactly one of: index, terminal",
        ));
    }
    app.emit(
        "iyke://tab-activate",
        json!({ "pane": body.pane, "index": body.index, "terminal": body.terminal }),
    )
    .map_err(|error| err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}
