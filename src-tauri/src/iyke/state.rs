//! Iyke runtime state. Holds the per-launch facts (pid, started_at) plus
//! the shell snapshot the frontend pushes via the `iyke_set_shell` Tauri
//! command. Handlers read from here to answer `GET /iyke/state`.
//!
//! Phase A also adds two ring buffers — console log + network event capture
//! — that the FE bridge feeds via `iyke_log_push` / `iyke_network_push`.
//! Reads through `GET /iyke/logs` and `/iyke/network`.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

const LOG_RING_CAP: usize = 500;
const NETWORK_RING_CAP: usize = 100;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellSnapshot {
    pub mode: Option<String>,
    pub route: Option<String>,
    /// Pane tree snapshot. Opaque to Rust — the FE owns the schema and
    /// pushes it via `iyke_set_shell`.
    pub panes: Option<Value>,
}

/// Console log entry. Source is "shell" for the main webview or a pane id
/// for an iframe mini-app (Phase B).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts: u128,
    pub level: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// Network event entry. Captures fetch + XHR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkEntry {
    pub ts: u128,
    pub method: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub duration_ms: u32,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

pub struct IykeState {
    shell: RwLock<ShellSnapshot>,
    logs: RwLock<VecDeque<LogEntry>>,
    network: RwLock<VecDeque<NetworkEntry>>,
    started_at_unix_ms: u128,
    pid: u32,
}

impl IykeState {
    pub fn new() -> Self {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        Self {
            shell: RwLock::new(ShellSnapshot::default()),
            logs: RwLock::new(VecDeque::with_capacity(LOG_RING_CAP)),
            network: RwLock::new(VecDeque::with_capacity(NETWORK_RING_CAP)),
            started_at_unix_ms: started,
            pid: std::process::id(),
        }
    }

    /// Update the shell snapshot. `None` fields leave the existing value
    /// untouched, so the frontend can push a partial update.
    pub async fn set_shell(
        &self,
        mode: Option<String>,
        route: Option<String>,
        panes: Option<Value>,
    ) {
        let mut guard = self.shell.write().await;
        if mode.is_some() {
            guard.mode = mode;
        }
        if route.is_some() {
            guard.route = route;
        }
        if panes.is_some() {
            guard.panes = panes;
        }
    }

    pub async fn snapshot(&self) -> ShellSnapshot {
        self.shell.read().await.clone()
    }

    pub async fn push_logs(&self, entries: Vec<LogEntry>) {
        let mut guard = self.logs.write().await;
        for entry in entries {
            if guard.len() == LOG_RING_CAP {
                guard.pop_front();
            }
            guard.push_back(entry);
        }
    }

    pub async fn push_network(&self, entries: Vec<NetworkEntry>) {
        let mut guard = self.network.write().await;
        for entry in entries {
            if guard.len() == NETWORK_RING_CAP {
                guard.pop_front();
            }
            guard.push_back(entry);
        }
    }

    pub async fn recent_logs(
        &self,
        level: Option<&str>,
        since: Option<u128>,
        source: Option<&str>,
    ) -> Vec<LogEntry> {
        let guard = self.logs.read().await;
        guard
            .iter()
            .filter(|e| level.map(|l| e.level == l).unwrap_or(true))
            .filter(|e| since.map(|s| e.ts >= s).unwrap_or(true))
            .filter(|e| source.map(|s| e.source.as_deref() == Some(s)).unwrap_or(true))
            .cloned()
            .collect()
    }

    pub async fn recent_network(
        &self,
        since: Option<u128>,
        source: Option<&str>,
    ) -> Vec<NetworkEntry> {
        let guard = self.network.read().await;
        guard
            .iter()
            .filter(|e| since.map(|s| e.ts >= s).unwrap_or(true))
            .filter(|e| source.map(|s| e.source.as_deref() == Some(s)).unwrap_or(true))
            .cloned()
            .collect()
    }

    pub fn started_at_unix_ms(&self) -> u128 {
        self.started_at_unix_ms
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}
