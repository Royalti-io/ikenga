//! agent-ops host bridge (WP-09 / **G-TRIGGER**).
//!
//! The privileged hops the agent-ops iframe pkg cannot make itself:
//!   * `agent_ops_run_now`     — fire an out-of-schedule run on the always-on
//!                               cron daemon via its localhost trigger endpoint
//!                               (WP-06). Reads the 0600 `~/.agent-ops/daemon.lock`
//!                               for `{ port, secret }` and POSTs with BOTH
//!                               required headers.
//!   * `agent_ops_set_enabled` — flip a job's `enabled` flag in the
//!                               project-scoped config (atomic rewrite); the
//!                               daemon honors it on next config load.
//!   * `agent_ops_list_jobs`   — read the project-scoped config + the daemon's
//!                               runtime state file, merged per job, + liveness.
//!
//! The shell is **observability / management only — it never becomes the
//! executor.** run-now does nothing but POST the daemon's own endpoint; the
//! daemon stays the single thing that fires jobs. All three commands are gated
//! FE-side by `capabilities.agentOps` (`pkg-iframe-host.tsx`) since `host.*`
//! verbs bypass the kernel's scope enforcement.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::Duration;

// ─── path resolution ─────────────────────────────────────────────────────────

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())
}

fn daemon_lock_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".agent-ops/daemon.lock"))
}

/// Project-scoped job config the skill + daemon read new-wins. Under $HOME.
fn project_config_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".atelier/skill-agent-ops/jobs.json"))
}

/// The daemon's runtime state file (`nextRunAtMs`, last-status, totals). Lives
/// in the royalti-co monorepo working tree, not under the app data dir. Resolve
/// it the way the daemon does, with overrides for non-default checkouts:
///   1. `AGENT_OPS_STATE_PATH` — full path to jobs-state.json
///   2. `AGENT_OPS_REPO_ROOT`  — `<root>/.company/cron/jobs-state.json`
///   3. default `$HOME/royalti-co/.company/cron/jobs-state.json`
/// Missing file is not an error — listJobs degrades to config-only (no
/// next-fire / state), which the pkg renders honestly.
fn jobs_state_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("AGENT_OPS_STATE_PATH") {
        return Ok(PathBuf::from(p));
    }
    if let Some(root) = std::env::var_os("AGENT_OPS_REPO_ROOT") {
        return Ok(PathBuf::from(root).join(".company/cron/jobs-state.json"));
    }
    Ok(home()?.join("royalti-co/.company/cron/jobs-state.json"))
}

// ─── daemon.lock ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DaemonLock {
    pid: u32,
    port: u16,
    secret: String,
}

/// Read + parse the daemon lock. `None` (with a reason) means the daemon is not
/// running / the lock is absent or malformed — callers map this to
/// `code: "daemon_down"`.
async fn read_daemon_lock() -> Result<DaemonLock, String> {
    let path = daemon_lock_path()?;
    let raw = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read daemon.lock: {e}"))?;
    serde_json::from_slice::<DaemonLock>(&raw).map_err(|e| format!("parse daemon.lock: {e}"))
}

/// Best-effort liveness: on Linux a live pid has a `/proc/<pid>` entry. On other
/// platforms, treat lock-present as up (the systemd supervisor keeps it alive).
fn pid_alive(pid: u32) -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        let _ = pid;
        true
    }
}

fn err_value(code: &str, status: Option<u16>, error: impl Into<String>) -> Value {
    json!({
        "ok": false,
        "code": code,
        "status": status,
        "error": error.into(),
    })
}

// ─── run-now ─────────────────────────────────────────────────────────────────

/// POST the daemon's localhost trigger endpoint to fire an out-of-schedule run.
/// Always resolves `Ok(Value)` carrying a `{ ok, ... }` payload (incl. typed
/// `code` on failure) so the FE always has a structured result to render; only
/// a genuinely unexpected internal error returns `Err`.
#[tauri::command]
pub async fn agent_ops_run_now(job_id: String) -> Result<Value, String> {
    let lock = match read_daemon_lock().await {
        Ok(l) => l,
        Err(e) => return Ok(err_value("daemon_down", None, e)),
    };

    let url = format!("http://127.0.0.1:{}/jobs/{}/trigger", lock.port, job_id);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        // Auth secret (timing-safe compared on the daemon).
        .header("x-agent-ops-token", &lock.secret)
        // Non-CORS-safelisted presence header — the daemon's DNS-rebinding
        // defense (rejects any request lacking it with 403). Value is ignored.
        .header("x-agent-ops-trigger", "1")
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        // Connection refused / timeout → daemon not actually listening.
        Err(e) => return Ok(err_value("daemon_down", None, format!("trigger POST failed: {e}"))),
    };

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let message = parsed
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| body.clone());

    if (200..300).contains(&status) {
        return Ok(json!({ "ok": true, "status": status, "message": message }));
    }
    let code = match status {
        401 => "unauthorized",
        403 | 405 => "forbidden",
        404 => "not_found",
        409 => "disabled",
        _ => "error",
    };
    Ok(err_value(code, Some(status), message))
}

// ─── set-enabled ─────────────────────────────────────────────────────────────

/// Flip a job's `enabled` flag in the project-scoped config. Atomic rewrite
/// (temp + rename on the same fs) so the live daemon never reads a torn file.
/// Preserves the file's array-vs-`{jobs:[]}` shape and pretty formatting.
#[tauri::command]
pub async fn agent_ops_set_enabled(job_id: String, enabled: bool) -> Result<Value, String> {
    let path = match project_config_path() {
        Ok(p) => p,
        Err(e) => return Ok(err_value("io_error", None, e)),
    };
    let raw = match tokio::fs::read(&path).await {
        Ok(r) => r,
        Err(e) => return Ok(err_value("io_error", None, format!("read config: {e}"))),
    };
    let mut root: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(err_value("io_error", None, format!("parse config: {e}"))),
    };

    // The jobs array may be the document root or under a `jobs` key.
    let found = {
        let arr: Option<&mut Vec<Value>> = if root.is_array() {
            root.as_array_mut()
        } else {
            root.get_mut("jobs").and_then(|j| j.as_array_mut())
        };
        let Some(arr) = arr else {
            return Ok(err_value("io_error", None, "config is not a jobs array"));
        };
        let mut hit = false;
        for job in arr.iter_mut() {
            if job.get("id").and_then(|v| v.as_str()) == Some(job_id.as_str()) {
                if let Some(obj) = job.as_object_mut() {
                    obj.insert("enabled".into(), Value::Bool(enabled));
                    hit = true;
                }
            }
        }
        hit
    };
    if !found {
        return Ok(err_value("not_found", None, format!("no job \"{job_id}\" in config")));
    }

    let serialized = match serde_json::to_string_pretty(&root) {
        Ok(s) => s + "\n",
        Err(e) => return Ok(err_value("io_error", None, format!("serialize config: {e}"))),
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = tokio::fs::write(&tmp, serialized.as_bytes()).await {
        return Ok(err_value("io_error", None, format!("write temp config: {e}")));
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Ok(err_value("io_error", None, format!("rename config: {e}")));
    }

    Ok(json!({ "ok": true, "jobId": job_id, "enabled": enabled }))
}

// ─── list-jobs ───────────────────────────────────────────────────────────────

fn jobs_array_from(root: Value) -> Vec<Value> {
    match root {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("jobs") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Read the project-scoped config + the daemon state file and return both,
/// merged per job, plus daemon liveness. Run history is NOT included (the pkg
/// reads cron_job_runs / agent_runs directly via host.dbQuery).
#[tauri::command]
pub async fn agent_ops_list_jobs() -> Result<Value, String> {
    // Config (required for the job list).
    let cfg_path = match project_config_path() {
        Ok(p) => p,
        Err(e) => return Ok(err_value("io_error", None, e)),
    };
    let cfg_raw = match tokio::fs::read(&cfg_path).await {
        Ok(r) => r,
        Err(e) => return Ok(err_value("io_error", None, format!("read config: {e}"))),
    };
    let cfg_root: Value = match serde_json::from_slice(&cfg_raw) {
        Ok(v) => v,
        Err(e) => return Ok(err_value("io_error", None, format!("parse config: {e}"))),
    };
    let cfg_jobs = jobs_array_from(cfg_root);

    // State (optional — missing degrades to config-only).
    let state_map: Map<String, Value> = match jobs_state_path() {
        Ok(p) => match tokio::fs::read(&p).await {
            Ok(r) => serde_json::from_slice::<Map<String, Value>>(&r).unwrap_or_default(),
            Err(_) => Map::new(),
        },
        Err(_) => Map::new(),
    };

    // Daemon liveness from the lock.
    let (daemon_up, daemon_pid) = match read_daemon_lock().await {
        Ok(l) => (pid_alive(l.pid), Some(l.pid)),
        Err(_) => (false, None),
    };

    let mut jobs: Vec<Value> = Vec::with_capacity(cfg_jobs.len());
    for job in cfg_jobs {
        let Some(obj) = job.as_object() else { continue };
        let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let state = state_map.get(&id).cloned().unwrap_or(Value::Null);
        let s = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(str::to_string);
        jobs.push(json!({
            "id": id,
            "label": s("label").unwrap_or_default(),
            "schedule": s("schedule").unwrap_or_default(),
            "schedule_dialect": s("schedule_dialect").unwrap_or_else(|| "5f".into()),
            "timezone": s("timezone").unwrap_or_else(|| "UTC".into()),
            "enabled": obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
            "command": s("command").unwrap_or_default(),
            "mode": s("mode").unwrap_or_else(|| "agent".into()),
            "model": obj.get("model").and_then(|v| v.as_str()),
            "agent": obj.get("agent").and_then(|v| v.as_str()),
            "_disabledReason": obj.get("_disabledReason").and_then(|v| v.as_str()),
            "state": state,
        }));
    }

    Ok(json!({
        "ok": true,
        "daemon_up": daemon_up,
        "daemon_pid": daemon_pid,
        "jobs": jobs,
    }))
}
