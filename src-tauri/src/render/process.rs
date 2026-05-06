//! Spawn the Remotion CLI and stream progress back to the webview.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::RenderEvent;

/// Resolve PA root: `$HOME/royalti-co/ikenga-desktop`.
///
/// v1 is dev-only — we know where the source tree lives. Production builds
/// will need a different strategy (bundled sidecar) per the phase 6 plan.
pub fn pa_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow!("$HOME not set"))?;
    let root = PathBuf::from(home).join("royalti-co/ikenga-desktop");
    if !root.exists() {
        return Err(anyhow!(
            "PA root not found at {} — render is dev-only in v1",
            root.display()
        ));
    }
    Ok(root)
}

fn remotion_bin(pa_root: &Path) -> Result<PathBuf> {
    let bin = pa_root.join("node_modules/.bin/remotion");
    if !bin.exists() {
        return Err(anyhow!(
            "remotion CLI not found at {}; run `bun install` in {}",
            bin.display(),
            pa_root.display()
        ));
    }
    Ok(bin)
}

/// Run a single render to completion. Emits exactly one terminal event
/// (`Complete`, `Error`, or `Cancelled`) before returning.
pub async fn run_render(
    app: &AppHandle,
    job_id: &str,
    composition_id: &str,
    props: &Value,
    output_path: &Path,
    child_slot: Arc<Mutex<Option<Child>>>,
) -> Result<()> {
    let topic = format!("render://{job_id}");
    let emit = |event: RenderEvent| {
        if let Err(e) = app.emit(&topic, event) {
            tracing::warn!(job = %job_id, "emit failed: {e}");
        }
    };

    // Resolve PA root + binary.
    let pa_root = match pa_root() {
        Ok(r) => r,
        Err(e) => {
            emit(RenderEvent::Error {
                message: format!("{e}"),
            });
            return Err(e);
        }
    };
    let bin = match remotion_bin(&pa_root) {
        Ok(b) => b,
        Err(e) => {
            emit(RenderEvent::Error {
                message: format!("{e}"),
            });
            return Err(e);
        }
    };

    // Build args. The entry-point is the side-effect-registering module.
    let entry_point = "src/video/index.ts";
    let props_arg = props.to_string();

    // `--log=info` keeps stderr useful but not so chatty that we drown
    // the parser. Remotion emits progress to stderr unconditionally.
    let mut cmd = Command::new(&bin);
    cmd.arg("render")
        .arg(entry_point)
        .arg(composition_id)
        .arg(output_path.as_os_str())
        .arg("--props")
        .arg(&props_arg)
        .arg("--log=info")
        .current_dir(&pa_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Tokio defaults `kill_on_drop` to false; flip it so panics in our
        // task don't leave orphaned ffmpeg processes.
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!(
                "spawn {} render: {e} (cwd={})",
                bin.display(),
                pa_root.display()
            );
            emit(RenderEvent::Error {
                message: msg.clone(),
            });
            return Err(anyhow!(msg));
        }
    };

    emit(RenderEvent::Started);

    // Take stdout/stderr handles before we move the Child into the slot.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Hand the Child to the JobManager so cancel() can kill it.
    {
        let mut slot = child_slot.lock().await;
        *slot = Some(child);
    }

    // Spawn line readers for both streams. Both pipe into the same
    // event channel via `app.emit`. They terminate when the child closes
    // its end of each pipe — i.e. when the process exits.
    let app_for_stdout = app.clone();
    let topic_for_stdout = topic.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            forward_lines(s, &app_for_stdout, &topic_for_stdout, false).await;
        }
    });

    let app_for_stderr = app.clone();
    let topic_for_stderr = topic.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            forward_lines(s, &app_for_stderr, &topic_for_stderr, true).await;
        }
    });

    // Wait for the child. We pull it back out of the slot to .wait() — this
    // also lets cancel() take it via kill() while we're parked here.
    let exit = {
        let mut slot = child_slot.lock().await;
        match slot.as_mut() {
            Some(child) => child.wait().await,
            // cancel() pulled the slot already → the process is gone.
            None => {
                emit(RenderEvent::Cancelled);
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Ok(());
            }
        }
    };
    // Drain stream readers so we don't lose tail output.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = exit.with_context(|| "wait render child")?;
    if status.success() {
        emit(RenderEvent::Complete {
            output_path: output_path.display().to_string(),
        });
        Ok(())
    } else {
        // SIGKILL from cancel() shows up as no exit code on Unix.
        if status.code().is_none() {
            emit(RenderEvent::Cancelled);
            Ok(())
        } else {
            let code = status.code().unwrap_or(-1);
            let msg = format!("remotion render exited with status {code}");
            emit(RenderEvent::Error {
                message: msg.clone(),
            });
            Err(anyhow!(msg))
        }
    }
}

/// Read lines from a stream and forward them as `Log` events. If `parse_progress`
/// is true, also attempt to extract `Rendered N/M frames` patterns and emit
/// `Progress` events alongside the log line.
async fn forward_lines<R: tokio::io::AsyncRead + Unpin>(
    stream: R,
    app: &AppHandle,
    topic: &str,
    parse_progress: bool,
) {
    let progress_re: Regex = Regex::new(r"(\d+)\s*/\s*(\d+)\s*frames").unwrap();
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if parse_progress {
            if let Some(cap) = progress_re.captures(&line) {
                if let (Some(n), Some(m)) = (cap.get(1), cap.get(2)) {
                    if let (Ok(rendered), Ok(total)) =
                        (n.as_str().parse::<f64>(), m.as_str().parse::<f64>())
                    {
                        if total > 0.0 {
                            let value = (rendered / total).clamp(0.0, 1.0);
                            let _ = app.emit(topic, RenderEvent::Progress { value });
                        }
                    }
                }
            }
        }
        let _ = app.emit(topic, RenderEvent::Log { line });
    }
}
