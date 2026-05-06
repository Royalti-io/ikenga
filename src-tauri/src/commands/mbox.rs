//! mbox sidecar bridge.
//!
//! Spawns the bundled `pa-mbox` sidecar (a self-contained bun-compiled binary
//! wrapping `thunderbird-reader.ts`), sends a single JSON-RPC request, and
//! collects streamed `email` / `ids` frames until a `done` or `error` frame
//! arrives.
//!
//! Each call spawns a fresh sidecar process — the parser is stateless and
//! startup is ~30ms, so pooling buys little. Revisit if we ever poll on a
//! hot loop.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::time::timeout;

use crate::sidecar::spawn_sidecar;

const SIDECAR_NAME: &str = "ikenga-mbox";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Mirrors the `ParsedEmail` shape produced by `thunderbird-reader.ts`. We keep
/// it as a strict struct rather than a `Value` so the frontend gets typed
/// results from `invoke`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedEmail {
    pub message_id: String,
    pub in_reply_to: Option<String>,
    pub from_address: String,
    pub to_address: Option<String>,
    pub cc_address: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub body_text: Option<String>,
    pub received_at: String,
    pub inbox_source: String,
}

/// Internal frame envelope. Untagged because the sidecar uses a `type` field
/// rather than serde's default tag handling.
#[derive(Debug, Deserialize)]
struct Frame {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

async fn rpc_collect_emails(_app: &AppHandle, request: Value) -> Result<Vec<ParsedEmail>, String> {
    let mut child = spawn_sidecar(SIDECAR_NAME, &[])
        .await
        .map_err(|e| format!("spawn sidecar {SIDECAR_NAME}: {e:#}"))?;

    let mut line = serde_json::to_string(&request).map_err(|e| format!("serialize req: {e}"))?;
    line.push('\n');
    child
        .write_stdin(line.as_bytes())
        .await
        .map_err(|e| format!("write to sidecar: {e}"))?;

    if let Some(mut stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(l)) = stderr.next_line().await {
                tracing::debug!(target: "mbox-sidecar", "{}", l);
            }
        });
    }

    let mut emails: Vec<ParsedEmail> = Vec::new();
    let mut done = false;
    let mut last_error: Option<String> = None;

    let result = timeout(DEFAULT_TIMEOUT, async {
        while let Ok(Some(line)) = child.stdout.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let frame: Frame = match serde_json::from_str(trimmed) {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!(line = trimmed, error = %e, "mbox sidecar emitted unparseable frame");
                    continue;
                }
            };
            match frame.kind.as_str() {
                "email" => {
                    if let Some(data) = frame.data {
                        match serde_json::from_value::<ParsedEmail>(data) {
                            Ok(e) => emails.push(e),
                            Err(e) => {
                                tracing::warn!(error = %e, "mbox: bad email frame shape")
                            }
                        }
                    }
                }
                "done" => {
                    done = true;
                    break;
                }
                "error" => {
                    last_error = Some(
                        frame
                            .error
                            .unwrap_or_else(|| "unknown sidecar error".into()),
                    );
                    done = true;
                    break;
                }
                // ids/pong/mailboxes are not expected here.
                _ => {}
            }
        }
        Ok::<(), String>(())
    })
    .await;

    // Best-effort cleanup. The sidecar exits on its own once stdin closes,
    // but a hung process would leak.
    child.kill().await;

    match result {
        Err(_) => Err("mbox sidecar timed out".into()),
        Ok(Err(e)) => Err(e),
        Ok(Ok(())) => {
            if let Some(err) = last_error {
                Err(err)
            } else if !done {
                Err("mbox sidecar terminated before done frame".into())
            } else {
                Ok(emails)
            }
        }
    }
}

/// Read all configured mailboxes and return parsed emails.
///
/// `since_iso`  — ISO 8601 timestamp; only emails received on/after this are returned.
/// `mailboxes`  — optional subset of mailbox keys (e.g. `["royalti-inbox"]`); omit for all.
/// `chunk_size` — bytes to read from each mbox file; defaults to 20MB.
#[tauri::command]
pub async fn mbox_read_all(
    app: AppHandle,
    since_iso: Option<String>,
    mailboxes: Option<Vec<String>>,
    chunk_size: Option<u64>,
) -> Result<Vec<ParsedEmail>, String> {
    tracing::info!(
        target: "mbox-sidecar",
        since_iso = ?since_iso,
        mailboxes = ?mailboxes,
        chunk_size = ?chunk_size,
        "mbox_read_all invoked"
    );
    let mut params = serde_json::Map::new();
    if let Some(s) = since_iso {
        params.insert("sinceIso".into(), Value::String(s));
    }
    if let Some(m) = mailboxes {
        params.insert("mailboxes".into(), json!(m));
    }
    if let Some(c) = chunk_size {
        params.insert("chunkSize".into(), json!(c));
    }
    let req = json!({ "id": "read-all", "method": "readAllMailboxes", "params": params });
    rpc_collect_emails(&app, req).await
}

/// Health-check the sidecar (also useful as a CI smoke test).
#[tauri::command]
pub async fn mbox_ping(_app: AppHandle) -> Result<bool, String> {
    let mut child = spawn_sidecar(SIDECAR_NAME, &[])
        .await
        .map_err(|e| format!("spawn sidecar: {e:#}"))?;
    child
        .write_stdin(b"{\"id\":\"p\",\"method\":\"ping\"}\n")
        .await
        .map_err(|e| format!("write: {e}"))?;

    let mut got_pong = false;
    let result = timeout(Duration::from_secs(5), async {
        while let Ok(Some(line)) = child.stdout.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(frame) = serde_json::from_str::<Frame>(trimmed) {
                if frame.kind == "pong" {
                    got_pong = true;
                }
                if frame.kind == "done" {
                    return;
                }
            }
        }
    })
    .await;

    child.kill().await;

    match result {
        Err(_) => Err("ping timed out".into()),
        Ok(()) => Ok(got_pong),
    }
}
