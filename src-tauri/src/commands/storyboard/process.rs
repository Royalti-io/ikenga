//! Shell-out to engine CLI scripts.
//!
//! `still:beat` is the only existing engine CLI used today by the standalone
//! storyboard app. Promote-rung iterates beats sequentially and calls
//! still:beat for each — mind MEMORY.md's image-generation rate limit:
//! never run Gemini concurrently.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::jobs::{emit_event, StoryboardJobEvent};
use super::paths::engine_root;

const STILL_TIMEOUT_SECS: u64 = 300; // 5 min per beat — Gemini hi-fi can be slow

/// Spawn `npm run still:beat -- --slug X --beat Y --rung lofi|hifi` in the
/// engine root. Streams stdout/stderr as Log events on the job topic.
/// Returns the still path captured from CLI writeback (re-read by caller
/// from storyboard.json).
pub async fn run_still_beat(
    app: &AppHandle,
    job_id: &str,
    slug: &str,
    beat_id: &str,
    rung: &str, // "lofi" | "hifi"
    child_slot: Arc<Mutex<Option<Child>>>,
) -> Result<()> {
    let root = engine_root()?;
    let mut cmd = Command::new("npm");
    cmd.arg("run")
        .arg("still:beat")
        .arg("--")
        .arg("--slug")
        .arg(slug)
        .arg("--beat")
        .arg(beat_id)
        .arg("--rung")
        .arg(rung)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn still:beat: {e} (cwd={})", root.display());
            emit_event(app, job_id, StoryboardJobEvent::Error { message: msg.clone() });
            return Err(anyhow!(msg));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut slot = child_slot.lock().await;
        *slot = Some(child);
    }

    // Stream stdout + stderr as Log events.
    let app_for_stdout = app.clone();
    let job_for_stdout = job_id.to_string();
    let stdout_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            forward_lines(s, &app_for_stdout, &job_for_stdout).await;
        }
    });
    let app_for_stderr = app.clone();
    let job_for_stderr = job_id.to_string();
    let stderr_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            forward_lines(s, &app_for_stderr, &job_for_stderr).await;
        }
    });

    let exit = tokio::time::timeout(
        std::time::Duration::from_secs(STILL_TIMEOUT_SECS),
        async {
            let mut slot = child_slot.lock().await;
            match slot.as_mut() {
                Some(c) => c.wait().await,
                None => Err(std::io::Error::other("cancelled")),
            }
        },
    )
    .await;

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    match exit {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) if status.code().is_none() => {
            emit_event(app, job_id, StoryboardJobEvent::Cancelled);
            Err(anyhow!("cancelled"))
        }
        Ok(Ok(status)) => {
            let msg = format!(
                "still:beat exited with status {}",
                status.code().unwrap_or(-1)
            );
            Err(anyhow!(msg))
        }
        Ok(Err(e)) => Err(anyhow!("wait still:beat: {e}")),
        Err(_) => Err(anyhow!("still:beat timed out after {STILL_TIMEOUT_SECS}s")),
    }
}

/// Read a still PNG path back from `compositions/{slug}/storyboard.json`. The
/// CLI writes this; we re-read to confirm it landed.
pub fn read_still_path_from_json(
    sb_json_path: &Path,
    beat_id: &str,
    rung_key: &str, // "1_lofi" | "2_hifi"
) -> Option<String> {
    let raw = std::fs::read_to_string(sb_json_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let beats = v.get("beats")?.as_array()?;
    let beat = beats.iter().find(|b| {
        b.get("id").and_then(|x| x.as_str()) == Some(beat_id)
    })?;
    let still = beat
        .get("rungs")?
        .get(rung_key)?
        .get("still_path")?
        .as_str()?;
    Some(still.to_string())
}

async fn forward_lines<R: tokio::io::AsyncRead + Unpin>(
    stream: R,
    app: &AppHandle,
    job_id: &str,
) {
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        emit_event(app, job_id, StoryboardJobEvent::Log { line });
    }
}
