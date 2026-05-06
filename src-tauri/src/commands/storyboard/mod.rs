//! Storyboard Tauri commands (phase 7).
//!
//! Surface (per inventory §9):
//!   - storyboard_render_still(slug, beat_id, rung)  — shell out to still:beat
//!   - storyboard_promote_rung(slug, target_rung)    — iterate beats sequentially
//!   - storyboard_list_concepts(slug)                — FS scan + .md parse
//!   - storyboard_export_json(slug, payload)         — write storyboard.json
//!   - storyboard_import_json(slug)                  — read storyboard.json
//!
//! CRUD goes direct via dbExec/dbQuery from the FE (matches phase 6 render
//! queue pattern). These commands only handle FS + shell-out work.

pub mod concepts;
pub mod jobs;
pub mod paths;
pub mod process;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

pub use jobs::{StoryboardJobManager, StoryboardJobManagerState};

use jobs::{emit_event, StoryboardJobEvent};

#[tauri::command]
pub async fn storyboard_list_concepts(slug: String) -> Result<Vec<concepts::ConceptFile>, String> {
    concepts::list_concepts(&slug).map_err(|e| format!("{e:#}"))
}

/// Materialize a SQLite-backed storyboard back to disk so the engine CLI can
/// read it. Caller assembles the full JSON payload from `storyboards` +
/// `storyboard_beats` and passes it as `payload`. Returns the absolute path
/// written.
#[tauri::command]
pub async fn storyboard_export_json(slug: String, payload: Value) -> Result<String, String> {
    let p = paths::storyboard_path(&slug).map_err(|e| format!("{e:#}"))?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&payload).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&tmp, &body).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(p.display().to_string())
}

/// Read `compositions/{slug}/storyboard.json` from disk. Returns the raw
/// JSON value; caller (FE) parses it and inserts into SQLite.
#[tauri::command]
pub async fn storyboard_import_json(slug: String) -> Result<Value, String> {
    let p = paths::storyboard_path(&slug).map_err(|e| format!("{e:#}"))?;
    if !p.exists() {
        return Err(format!("storyboard.json not found at {}", p.display()));
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))
}

/// Render a single beat still by shelling out to `npm run still:beat`. The
/// caller supplies a pre-allocated job id (so the row is in SQLite before we
/// emit any events). Progress events flow on `storyboard://{job_id}`.
///
/// Returns the still path captured from the engine's storyboard.json
/// writeback. Caller updates the SQLite beat row with this path + flips
/// status to 'pending-review'.
#[tauri::command]
pub async fn storyboard_render_still(
    app: AppHandle,
    manager: State<'_, StoryboardJobManagerState>,
    #[allow(non_snake_case)] jobId: String,
    slug: String,
    #[allow(non_snake_case)] beatId: String,
    rung: u8, // 1 | 2
) -> Result<Option<String>, String> {
    let rung_label = match rung {
        1 => "lofi",
        2 => "hifi",
        _ => return Err(format!("invalid rung: {rung}")),
    };
    let rung_key = match rung {
        1 => "1_lofi",
        2 => "2_hifi",
        _ => unreachable!(),
    };

    let sb_path = paths::storyboard_path(&slug).map_err(|e| format!("{e:#}"))?;
    if !sb_path.exists() {
        return Err(format!(
            "storyboard.json not found at {} — call storyboard_export_json first",
            sb_path.display()
        ));
    }

    let child_slot = Arc::new(Mutex::new(None));
    manager.register(&jobId, child_slot.clone());
    emit_event(&app, &jobId, StoryboardJobEvent::Started);

    let result = process::run_still_beat(
        &app,
        &jobId,
        &slug,
        &beatId,
        rung_label,
        child_slot,
    )
    .await;

    manager.forget(&jobId);

    match result {
        Ok(()) => {
            let still_path = process::read_still_path_from_json(&sb_path, &beatId, rung_key);
            if let Some(path) = &still_path {
                emit_event(
                    &app,
                    &jobId,
                    StoryboardJobEvent::StillReady {
                        beat_id: beatId.clone(),
                        rung: rung_label.to_string(),
                        still_path: path.clone(),
                    },
                );
            }
            emit_event(&app, &jobId, StoryboardJobEvent::Complete);
            Ok(still_path)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            emit_event(
                &app,
                &jobId,
                StoryboardJobEvent::Error {
                    message: msg.clone(),
                },
            );
            Err(msg)
        }
    }
}

/// Promote-rung: iterate beats sequentially (Gemini rate-limit safe), render
/// stills for each. Caller passes the ordered beat-id list (FE has the
/// canonical order from SQLite); we don't re-derive it here.
///
/// `beats` is the list of beat ids to promote. `target_rung` is 1 or 2.
#[tauri::command]
pub async fn storyboard_promote_rung(
    app: AppHandle,
    manager: State<'_, StoryboardJobManagerState>,
    #[allow(non_snake_case)] jobId: String,
    slug: String,
    beats: Vec<String>,
    #[allow(non_snake_case)] targetRung: u8,
) -> Result<Vec<StillResult>, String> {
    let rung_label = match targetRung {
        1 => "lofi",
        2 => "hifi",
        _ => return Err(format!("invalid rung: {targetRung}")),
    };
    let rung_key = match targetRung {
        1 => "1_lofi",
        2 => "2_hifi",
        _ => unreachable!(),
    };

    let sb_path = paths::storyboard_path(&slug).map_err(|e| format!("{e:#}"))?;
    if !sb_path.exists() {
        return Err(format!(
            "storyboard.json not found at {} — call storyboard_export_json first",
            sb_path.display()
        ));
    }

    emit_event(&app, &jobId, StoryboardJobEvent::Started);

    let total = beats.len() as f64;
    let mut results: Vec<StillResult> = Vec::with_capacity(beats.len());

    for (idx, beat_id) in beats.iter().enumerate() {
        // Per-beat child slot so each spawn is isolated.
        let child_slot = Arc::new(Mutex::new(None));
        manager.register(&jobId, child_slot.clone());

        let single = process::run_still_beat(
            &app,
            &jobId,
            &slug,
            beat_id,
            rung_label,
            child_slot,
        )
        .await;

        manager.forget(&jobId);

        match single {
            Ok(()) => {
                let still_path =
                    process::read_still_path_from_json(&sb_path, beat_id, rung_key);
                if let Some(path) = &still_path {
                    emit_event(
                        &app,
                        &jobId,
                        StoryboardJobEvent::StillReady {
                            beat_id: beat_id.clone(),
                            rung: rung_label.to_string(),
                            still_path: path.clone(),
                        },
                    );
                }
                results.push(StillResult {
                    beat_id: beat_id.clone(),
                    still_path,
                    error: None,
                });
            }
            Err(e) => {
                let msg = format!("{e:#}");
                results.push(StillResult {
                    beat_id: beat_id.clone(),
                    still_path: None,
                    error: Some(msg.clone()),
                });
                // Continue rather than abort: a single bad beat shouldn't
                // sink the whole rung. The user can rework + re-render
                // individual beats afterwards.
                emit_event(
                    &app,
                    &jobId,
                    StoryboardJobEvent::Log {
                        line: format!("[storyboard] beat {beat_id} failed: {msg}"),
                    },
                );
            }
        }

        let value = ((idx + 1) as f64 / total).clamp(0.0, 1.0);
        emit_event(&app, &jobId, StoryboardJobEvent::Progress { value });
    }

    emit_event(&app, &jobId, StoryboardJobEvent::Complete);
    Ok(results)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StillResult {
    pub beat_id: String,
    pub still_path: Option<String>,
    pub error: Option<String>,
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn ensure_engine() -> Result<PathBuf> {
    paths::engine_root().map_err(|e| anyhow!("{e:#}"))
}
