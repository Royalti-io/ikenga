//! MCP stdio client — spawn-per-call.
//!
//! When an iframe-mounted MCP App fires `tools/call`, the host bridge calls
//! `pkg_mcp_call` which delegates here. We spawn the package's MCP server as
//! a stdio child, perform the spec handshake (initialize → initialized →
//! tools/call), capture the result, and tear the child down.
//!
//! Why spawn-per-call (not a pool):
//! - Synthetic fixture latency budget is 5s; spawning Node takes <100ms.
//! - Pools complicate teardown on uninstall and don't matter until we're
//!   serving real packages with multi-call workflows. Hyperframes will
//!   upgrade this to a per-pkg long-lived process.
//!
//! Protocol: MCP over stdio uses newline-delimited JSON-RPC 2.0. Each
//! message is one line. We don't implement Content-Length framing.
//!
//! Working directory for the child is the package's install_path. Relative
//! paths in `args` (like `server.js`) resolve against it. Env is layered
//! over the parent's environment with manifest entries taking precedence.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::pkg::manifest::McpServer;

const PROTOCOL_VERSION: &str = "2025-06-18";
const CLIENT_NAME: &str = "ikenga-desktop";
const CLIENT_VERSION: &str = "0.1.0";
/// Per-call wallclock cap (initialize + tools/call). Slow servers should
/// stream progress notifications rather than block past this.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Run the full handshake + tools/call against a package's MCP server and
/// return the JSON-RPC `result` payload from the `tools/call` response.
///
/// `extra_env` is layered onto the child env BEFORE the manifest entries so
/// a pkg can still override (e.g. set `PATH`); Phase 5 of projects-first-
/// class threads `IKENGA_PROJECT_ID` + `IKENGA_PROJECT_ROOT` through here.
pub async fn call_tool(
    install_path: &Path,
    server: &McpServer,
    tool: &str,
    args: Value,
    extra_env: &HashMap<String, String>,
) -> Result<Value> {
    let mut cmd = Command::new(crate::runtime::resolve_command(&server.command));
    cmd.args(&server.args);
    cmd.current_dir(install_path);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    for (k, v) in &server.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn `{} {:?}`", server.command, server.args))?;

    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let mut reader = BufReader::new(stdout).lines();

    let result = timeout(CALL_TIMEOUT, async {
        // 1. initialize
        write_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
                },
            }),
        )
        .await?;
        let _init_resp = expect_response(&mut reader, 1).await?;

        // 2. notifications/initialized — server expects this before serving.
        write_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            }),
        )
        .await?;

        // 3. tools/call
        write_line(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": { "name": tool, "arguments": args },
            }),
        )
        .await?;
        let resp = expect_response(&mut reader, 2).await?;
        Ok::<Value, anyhow::Error>(resp)
    })
    .await
    .map_err(|_| anyhow!("mcp tool `{}` timed out after {:?}", tool, CALL_TIMEOUT))??;

    // Best-effort shutdown. drop(stdin) closes the pipe; the child should
    // exit on its own. kill_on_drop in Command guarantees it dies if not.
    drop(stdin);
    let _ = child.wait().await;

    Ok(result)
}

async fn write_line(stdin: &mut tokio::process::ChildStdin, msg: &Value) -> Result<()> {
    let mut buf = serde_json::to_vec(msg)?;
    buf.push(b'\n');
    stdin.write_all(&buf).await.context("write stdin")?;
    stdin.flush().await.ok();
    Ok(())
}

#[derive(Deserialize)]
struct RpcEnvelope {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

/// Read lines until we see a JSON-RPC response with the requested id. Lines
/// without `id` are treated as notifications and skipped. Errors with the
/// matching id are surfaced.
async fn expect_response<R>(reader: &mut tokio::io::Lines<BufReader<R>>, id: i64) -> Result<Value>
where
    R: tokio::io::AsyncRead + Unpin,
{
    loop {
        let line = match reader.next_line().await? {
            Some(l) => l,
            None => return Err(anyhow!("mcp server closed stdout before id={id}")),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let env: RpcEnvelope = match serde_json::from_str(trimmed) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[mcp_runtime] non-JSON line dropped: {e} :: {trimmed:.120}");
                continue;
            }
        };
        let Some(env_id) = env.id.as_ref().and_then(Value::as_i64) else {
            // Notification — ignore.
            continue;
        };
        if env_id != id {
            continue;
        }
        if let Some(err) = env.error {
            return Err(anyhow!(
                "mcp server returned error code={} message={}",
                err.code,
                err.message
            ));
        }
        return env
            .result
            .ok_or_else(|| anyhow!("mcp response id={id} had no result and no error"));
    }
}

/// Pick the MCP server entry for a package by name. If `name` is empty and
/// the package has exactly one server, return that one (smoke-test path).
pub fn pick_server<'a>(servers: &'a [McpServer], name: &str) -> Result<&'a McpServer> {
    if servers.is_empty() {
        return Err(anyhow!("package declares no mcp servers"));
    }
    if name.is_empty() {
        if servers.len() == 1 {
            return Ok(&servers[0]);
        }
        return Err(anyhow!(
            "package declares {} mcp servers; specify which by name",
            servers.len()
        ));
    }
    servers
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow!("no mcp server named `{name}`"))
}

