//! Streaming RPC for long-lived pkg-declared sidecars.
//!
//! `pkg_sidecar_call` (sibling module) handles one-shot invocations: spawn,
//! pass args + stdin, wait for exit, return captured stdout. That's wrong for
//! sidecars that maintain in-memory state across many requests — language
//! servers, persistent daemons, anything where every call would re-pay the
//! cold-start tax.
//!
//! This module exposes a streaming pair:
//!
//!   • `pkg_sidecar_rpc_send(pkg_id, name, line)` — lazy-spawn the binary on
//!     first call, then write `line + '\n'` to its stdin. Subsequent calls
//!     reuse the live child.
//!   • `pkg://sidecar/{pkg_id}/{name}/message` — Tauri event emitted once
//!     per UTF-8 line read from the child's stdout. Subscribe on the FE via
//!     `@tauri-apps/api/event::listen`.
//!
//! Restart policy: on child exit (clean or crashed) the entry is dropped.
//! Next `pkg_sidecar_rpc_send` spawns a fresh child. No backoff is applied
//! here — pipeline assumes the FE caller is the one that decides whether to
//! retry. (For complex circuit-breaker semantics, prefer declaring the
//! process as a long-lived MCP server instead.)
//!
//! Permission model mirrors `pkg_sidecar_call`: the registry binds each
//! sidecar `name` to a single `pkg_id`; cross-pkg invocation is refused.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;
use std::sync::Mutex as StdMutex;

use crate::commands::pkg::KernelState;
use crate::commands::pkg_sidecar::SidecarsRegistryState;

/// Key into the streaming map: `(pkg_id, sidecar_name)`.
type StreamKey = (String, String);

struct StreamEntry {
    stdin: Arc<AsyncMutex<ChildStdin>>,
}

#[derive(Default)]
pub struct StreamingSidecarManager {
    children: StdMutex<HashMap<StreamKey, StreamEntry>>,
}

impl StreamingSidecarManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Global singleton. We were seeing "B sees empty map" symptoms when
/// state-managed via `tauri::State` — concurrent invocations behaved as if
/// they were holding different `Arc`s despite identical address logs. A
/// static singleton sidesteps any Tauri State quirks and gives us an
/// unambiguous, single shared instance.
static STREAMING_MANAGER: OnceLock<Arc<StreamingSidecarManager>> = OnceLock::new();

fn global_manager() -> &'static Arc<StreamingSidecarManager> {
    STREAMING_MANAGER.get_or_init(|| Arc::new(StreamingSidecarManager::new()))
}

pub struct StreamingSidecarManagerState(pub Arc<StreamingSidecarManager>);

/// FE -> kernel: append one line to the supervised child's stdin. Lazily
/// spawns the child on first call. The newline terminator is appended by
/// this function; callers send the JSON-RPC payload only.
#[tauri::command]
pub async fn pkg_sidecar_rpc_send(
    app: AppHandle,
    kernel: State<'_, KernelState>,
    sidecars: State<'_, SidecarsRegistryState>,
    pkg_id: String,
    name: String,
    message: String,
) -> Result<(), String> {
    let manager = global_manager().clone();
    let install_path = kernel
        .0
        .installed_path(&pkg_id)
        .ok_or_else(|| format!("pkg `{pkg_id}` is not installed"))?;

    let entry = sidecars
        .0
         .resolve(&name)
        .ok_or_else(|| {
            format!(
                "sidecar `{name}` is not registered (pkg may not be installed or declares no such sidecar)"
            )
        })?;
    if entry.pkg_id != pkg_id {
        return Err(format!(
            "sidecar `{name}` belongs to `{}`, not `{pkg_id}`",
            entry.pkg_id
        ));
    }

    let key: StreamKey = (pkg_id.clone(), name.clone());

    // std::sync::Mutex — held synchronously across cmd.spawn() (which is
    // itself sync). Required because tokio::sync::Mutex was exhibiting an
    // unexplained visibility issue where two concurrent invocations both
    // saw empty map despite the previous call's insert being verified-
    // present immediately after.
    //
    // We do all the locked work in a sync block, returning the stdin Arc
    // outside so the MutexGuard (which is !Send) never crosses an .await.
    let stdin = {
        let mut children = manager.children.lock().expect("children mutex poisoned");
        if let Some(e) = children.get(&key) {
            e.stdin.clone()
        } else {
            log::info!(
                "[pkg_sidecar_rpc_send] spawning fresh sidecar for {}::{}",
                key.0, key.1
            );
            let stdin_arc = spawn_streaming_child_sync(
                app.clone(),
                manager.clone(),
                key.clone(),
                entry.bin_path.clone(),
                install_path,
            )?;
            children.insert(
                key.clone(),
                StreamEntry {
                    stdin: stdin_arc.clone(),
                },
            );
            stdin_arc
        }
    };
    write_line(stdin, &message).await
}

async fn write_line(stdin: Arc<AsyncMutex<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    guard
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write: {e}"))?;
    guard.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

fn spawn_streaming_child_sync(
    app: AppHandle,
    manager: Arc<StreamingSidecarManager>,
    key: StreamKey,
    bin_path: PathBuf,
    install_path: PathBuf,
) -> Result<Arc<AsyncMutex<ChildStdin>>, String> {
    log::info!(
        "[pkg_sidecar_rpc_send] spawning streaming sidecar pkg={} name={} bin={}",
        key.0,
        key.1,
        bin_path.display()
    );

    let mut cmd = Command::new(&bin_path);
    cmd.current_dir(&install_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn `{}`: {e}", bin_path.display()))?;
    let pid = child.id().unwrap_or(0);

    let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take();

    // Tauri rejects `.` in event names; substitute with `_` so a pkg id like
    // `com.ikenga.tsserver-lsp` becomes a valid `com_ikenga_tsserver-lsp`
    // event-channel segment. Consumers must apply the same substitution.
    let safe_pkg = key.0.replace('.', "_");
    let safe_name = key.1.replace('.', "_");
    let event_name = format!("pkg://sidecar/{safe_pkg}/{safe_name}/message");
    let exit_event = format!("pkg://sidecar/{safe_pkg}/{safe_name}/exit");

    // stdout reader → Tauri event
    {
        let app = app.clone();
        let event_name = event_name.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Err(e) = app.emit(&event_name, trimmed.to_string()) {
                            log::warn!("[pkg_sidecar_rpc_send] emit failed: {e}");
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[pkg_sidecar_rpc_send] stdout read error pid={pid}: {e}"
                        );
                        break;
                    }
                }
            }
            log::info!("[pkg_sidecar_rpc_send] stdout closed pid={pid}");
        });
    }

    // stderr drain → debug log
    if let Some(stderr) = stderr {
        let key_for_log = key.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        log::info!(
                            "[sidecar {}::{}] {}",
                            key_for_log.0,
                            key_for_log.1,
                            line.trim_end()
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Lifecycle watcher: when child exits, remove the map entry so the next
    // RPC send spawns fresh.
    {
        let app = app.clone();
        let manager = manager.clone();
        let key = key.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            log::info!(
                "[pkg_sidecar_rpc_send] child exited pkg={} name={} status={:?}",
                key.0, key.1, status
            );
            let mut children = manager.children.lock().expect("children mutex poisoned");
            children.remove(&key);
            drop(children);
            let _ = app.emit(&exit_event, ());
        });
    }

    Ok(Arc::new(AsyncMutex::new(stdin)))
}

/// Explicit shutdown — drop the live entry so the child sees stdin EOF.
/// Optional for callers; the child also dies if the app exits (kill_on_drop).
#[tauri::command]
pub async fn pkg_sidecar_rpc_shutdown(
    pkg_id: String,
    name: String,
) -> Result<bool, String> {
    let manager = global_manager().clone();
    let mut children = manager.children.lock().expect("children mutex poisoned");
    Ok(children.remove(&(pkg_id, name)).is_some())
}
