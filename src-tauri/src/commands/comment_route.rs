//! Routing dispatcher for artifact-grid pin comments.
//!
//! When the user clicks a pin in the artifact grid (or `art.notes.send` is
//! called from inside an artifact), this command decides where the
//! structured prompt should land:
//!
//! - **Terminal** — preferred when an active claude PTY exists. Writes a
//!   one-line prompt referencing the pin id; claude then pulls the full
//!   payload via `mcp-iyke.read_pin(id)`.
//! - **Side-pane Chat** — fallback when no claude PTY is detected. Emits a
//!   `pin://routed` event with the structured payload so the FE can post
//!   it into the active side-pane Chat thread.
//! - **Both** — explicit override; runs both branches.
//!
//! Per-click override goes through the `override_sink` argument. Without
//! it the dispatcher auto-detects.
//!
//! Failure modes:
//! - **Busy PTY**: a future enhancement; v0 always writes immediately.
//! - **No mcp-iyke**: handled implicitly — claude in the terminal will fail
//!   the `read_pin` call and surface the error to the user.
//! - **Nothing configured**: returns the `NoSink` result; FE can surface a
//!   toast directing the user to open `claude` in a terminal or open a
//!   side-pane Chat thread.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::comments::{comment_get, comment_record_routing, Comment};
use super::db::PaDb;
use crate::pty::PtyManager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteSink {
    Terminal,
    Sidepane,
    Both,
}

impl RouteSink {
    fn as_str(&self) -> &'static str {
        match self {
            RouteSink::Terminal => "terminal",
            RouteSink::Sidepane => "sidepane",
            RouteSink::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteResult {
    /// The sink the dispatcher actually used. `NoSink` when nothing was
    /// reachable (FE should toast).
    pub sink: Option<String>,
    /// PTY id the prompt was written to, when the terminal sink was used.
    /// Useful for the grid UI to show "delivered to term 2 · claude".
    pub pty_id: Option<String>,
    /// Foreground process name on that PTY at routing time. Lets the FE
    /// distinguish "claude" from a wrapper like "claude-code". Audit only.
    pub pty_foreground: Option<String>,
    /// Updated comment after the routing fields were recorded.
    pub comment: Comment,
}

#[derive(Debug, Clone, Serialize)]
pub struct PinRoutedEvent {
    pub id: i64,
    pub sink: String,
    pub artifact_path: String,
    pub selector: String,
    pub text: String,
    pub screenshot_path: Option<String>,
}

/// Dispatch a pin to its routing sink. The FE typically invokes this
/// after creating a pin (or when the user re-clicks an existing pin to
/// re-route). `override_sink` forces a specific sink; omit to auto-detect.
#[tauri::command]
pub async fn comment_route(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    pty: State<'_, Arc<PtyManager>>,
    id: i64,
    override_sink: Option<RouteSink>,
    preferred_pty_id: Option<String>,
) -> Result<RouteResult, String> {
    let comment = comment_get(db.clone(), id).await?;

    // Pick the active claude PTY, if any. This is the auto-detect path.
    let claude_pty = pick_claude_pty(&pty, preferred_pty_id.as_deref());

    let chosen = match override_sink {
        Some(RouteSink::Terminal) => RouteSink::Terminal,
        Some(RouteSink::Sidepane) => RouteSink::Sidepane,
        Some(RouteSink::Both) => RouteSink::Both,
        None => {
            if claude_pty.is_some() {
                RouteSink::Terminal
            } else {
                RouteSink::Sidepane
            }
        }
    };

    let mut pty_id_used: Option<String> = None;
    let mut pty_foreground_used: Option<String> = None;
    let mut wrote_anywhere = false;

    if matches!(chosen, RouteSink::Terminal | RouteSink::Both) {
        if let Some((pty_id, fg_name)) = &claude_pty {
            let line = format!(
                "address pin #{} (artifact: {} · selector: {})\n",
                comment.id, comment.artifact_path, comment.selector
            );
            // Best-effort write — if the PTY died between the snapshot and the
            // write call, fall through to the sidepane branch when allowed.
            if pty.write(pty_id, line.as_bytes()).is_ok() {
                pty_id_used = Some(pty_id.clone());
                pty_foreground_used = Some(fg_name.clone());
                wrote_anywhere = true;
            }
        }
    }

    if matches!(chosen, RouteSink::Sidepane | RouteSink::Both)
        || (matches!(chosen, RouteSink::Terminal) && !wrote_anywhere)
    {
        let payload = PinRoutedEvent {
            id: comment.id,
            sink: "sidepane".to_string(),
            artifact_path: comment.artifact_path.clone(),
            selector: comment.selector.clone(),
            text: comment.text.clone(),
            screenshot_path: comment.screenshot_path.clone(),
        };
        let _ = app.emit("pin://routed", payload);
        wrote_anywhere = true;
    }

    if !wrote_anywhere {
        return Ok(RouteResult {
            sink: None,
            pty_id: None,
            pty_foreground: None,
            comment,
        });
    }

    let recorded_sink = match (chosen.clone(), pty_id_used.is_some()) {
        // Both branches actually ran.
        (RouteSink::Both, true) => "both",
        // Terminal was requested but it actually fell back to sidepane.
        (RouteSink::Terminal, false) => "sidepane",
        // Single-sink, fired as requested.
        (sink, _) => sink.as_str(),
    };

    let updated =
        comment_record_routing(db, comment.id, recorded_sink.to_string(), None, None).await?;

    Ok(RouteResult {
        sink: Some(recorded_sink.to_string()),
        pty_id: pty_id_used,
        pty_foreground: pty_foreground_used,
        comment: updated,
    })
}

/// Pick a PTY whose foreground command is `claude` (or `claude-*`).
///
/// When `preferred_pty_id` is supplied and that PTY's foreground is still
/// claude, it wins — this lets the FE pin delivery to the *visible* terminal
/// (the most-recently-focused tab) rather than letting HashMap iteration
/// arbitrarily pick a sibling claude PTY. The fallback path scans the full
/// snapshot.
fn pick_claude_pty(pty: &PtyManager, preferred_pty_id: Option<&str>) -> Option<(String, String)> {
    let snap = pty.foreground_snapshot();
    if let Some(preferred) = preferred_pty_id {
        if let Some(fg) = snap.get(preferred) {
            if fg.name.starts_with("claude") {
                return Some((preferred.to_string(), fg.name.clone()));
            }
        }
    }
    snap.into_iter()
        .find(|(_, fg)| fg.name.starts_with("claude"))
        .map(|(id, fg)| (id, fg.name))
}
