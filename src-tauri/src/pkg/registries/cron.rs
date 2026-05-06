//! Cron registry — schedules per-package recurring jobs.
//!
//! Each manifest cron entry is `{ id, expr, handler }`. `expr` is a 6-field
//! cron expression (sec min hour day month dow — tokio-cron-scheduler's
//! native shape). `handler` reuses the same parser as the iyke routes
//! registry today: `event:<name>` emits a Tauri event named `pkg://<name>`,
//! `sidecar:<name> <sub>` is declared but not yet wired (returns a warning).
//!
//! Job-key shape: `<pkg_id>::<cron_id>`. We keep a `pkg_id → [(cron_id,
//! Uuid)]` map so uninstall can remove the right scheduler entries without
//! scanning everything. The scheduler itself is lazy-initialized on first
//! register so packages with no cron entries don't pay the startup cost.

use std::collections::HashMap;
use std::sync::RwLock;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

/// One scheduled job, surfaced in the kernel snapshot. `job_uuid` is the
/// scheduler-internal id we use on remove.
#[derive(Debug, Clone)]
struct CronJob {
    pkg_id: String,
    cron_id: String,
    expr: String,
    handler: String,
    job_uuid: Uuid,
}

pub struct CronRegistry {
    app: AppHandle,
    /// `JobScheduler` is async; lazy-init under a tokio Mutex so multiple
    /// registers don't race the first construction.
    sched: tokio::sync::Mutex<Option<JobScheduler>>,
    jobs: RwLock<HashMap<String, Vec<CronJob>>>,
}

impl CronRegistry {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sched: tokio::sync::Mutex::new(None),
            jobs: RwLock::new(HashMap::new()),
        }
    }

    async fn ensure_sched(&self) -> Result<JobScheduler> {
        let mut guard = self.sched.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let s = JobScheduler::new()
            .await
            .map_err(|e| anyhow!("create job scheduler: {e}"))?;
        s.start()
            .await
            .map_err(|e| anyhow!("start job scheduler: {e}"))?;
        *guard = Some(s.clone());
        Ok(s)
    }

    fn parse_handler(spec: &str) -> Result<HandlerSpec> {
        let spec = spec.trim();
        if let Some(rest) = spec.strip_prefix("event:") {
            let name = rest.trim();
            if name.is_empty() {
                return Err(anyhow!("event handler missing name"));
            }
            return Ok(HandlerSpec::Event(name.to_string()));
        }
        if let Some(rest) = spec.strip_prefix("sidecar:") {
            let mut parts = rest.trim().splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or("").trim();
            let sub = parts.next().unwrap_or("").trim();
            if name.is_empty() || sub.is_empty() {
                return Err(anyhow!(
                    "sidecar handler must be `sidecar:<name> <subcommand>`"
                ));
            }
            return Ok(HandlerSpec::Sidecar {
                name: name.to_string(),
                subcommand: sub.to_string(),
            });
        }
        Err(anyhow!(
            "unknown cron handler `{spec}` (use `event:<name>` or `sidecar:<name> <sub>`)"
        ))
    }
}

enum HandlerSpec {
    Event(String),
    Sidecar { name: String, subcommand: String },
}

impl Registry for CronRegistry {
    fn name(&self) -> &'static str {
        "cron"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        if pkg.manifest.cron.is_empty() {
            return Ok(());
        }

        // Idempotent: drop any existing jobs for this pkg first so a re-
        // register (boot replay) doesn't stack scheduler entries.
        self.unregister(&pkg.manifest.id).ok();

        // Validate everything before touching the scheduler.
        let mut parsed: Vec<(String, String, HandlerSpec)> = Vec::new();
        for entry in &pkg.manifest.cron {
            let h = Self::parse_handler(&entry.handler)
                .map_err(|e| anyhow!("cron `{}/{}`: {e}", pkg.manifest.id, entry.id))?;
            parsed.push((entry.id.clone(), entry.expr.clone(), h));
        }

        let pkg_id = pkg.manifest.id.clone();
        let app = self.app.clone();
        let mut new_jobs: Vec<CronJob> = Vec::new();

        // Scheduler ops are async; do them all in one block_on.
        let sched_jobs: Vec<(String, String, String, Uuid)> = tauri::async_runtime::block_on(async move {
            let sched = self.ensure_sched().await?;
            let mut out: Vec<(String, String, String, Uuid)> = Vec::new();
            for (cron_id, expr, handler) in parsed {
                let app_inner = app.clone();
                let pkg_inner = pkg_id.clone();
                let cron_inner = cron_id.clone();
                let handler_for_log = match &handler {
                    HandlerSpec::Event(n) => format!("event:{n}"),
                    HandlerSpec::Sidecar { name, subcommand } => format!("sidecar:{name} {subcommand}"),
                };
                let job = match handler {
                    HandlerSpec::Event(name) => Job::new(expr.as_str(), move |_uuid, _l| {
                        let event = format!("pkg://{name}");
                        let payload = json!({
                            "pkg_id": pkg_inner,
                            "cron_id": cron_inner,
                        });
                        if let Err(e) = app_inner.emit(&event, payload) {
                            log::warn!("[pkg.cron] emit `{event}` failed: {e}");
                        }
                    })
                    .map_err(|e| anyhow!("build cron job `{cron_id}` (`{expr}`): {e}"))?,
                    HandlerSpec::Sidecar { name, subcommand } => {
                        log::warn!(
                            "[pkg.cron] sidecar handler not yet wired — skipping `{name} {subcommand}` for `{pkg_inner}::{cron_id}`"
                        );
                        continue;
                    }
                };
                let job_uuid = sched
                    .add(job)
                    .await
                    .map_err(|e| anyhow!("schedule cron `{cron_id}`: {e}"))?;
                out.push((cron_id, expr, handler_for_log, job_uuid));
            }
            Ok::<_, anyhow::Error>(out)
        })?;

        for (cron_id, expr, handler, job_uuid) in sched_jobs {
            new_jobs.push(CronJob {
                pkg_id: pkg.manifest.id.clone(),
                cron_id,
                expr,
                handler,
                job_uuid,
            });
        }

        let mut map = self
            .jobs
            .write()
            .map_err(|_| anyhow!("cron registry lock poisoned"))?;
        map.insert(pkg.manifest.id.clone(), new_jobs);
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let to_remove: Vec<Uuid> = {
            let mut map = self
                .jobs
                .write()
                .map_err(|_| anyhow!("cron registry lock poisoned"))?;
            map.remove(pkg_id)
                .map(|v| v.into_iter().map(|j| j.job_uuid).collect())
                .unwrap_or_default()
        };
        if to_remove.is_empty() {
            return Ok(());
        }
        let _ = tauri::async_runtime::block_on(async move {
            // Only acquire the scheduler if it was already initialized; if not,
            // there are no jobs to remove anyway.
            let sched = {
                let guard = self.sched.lock().await;
                guard.clone()
            };
            if let Some(s) = sched {
                for uuid in to_remove {
                    if let Err(e) = s.remove(&uuid).await {
                        log::warn!("[pkg.cron] remove job {uuid} failed: {e}");
                    }
                }
            }
            Ok::<_, anyhow::Error>(())
        });
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let map = match self.jobs.read() {
            Ok(g) => g,
            Err(_) => return json!({ "error": "lock poisoned" }),
        };
        let entries: Vec<Value> = map
            .values()
            .flatten()
            .map(|j| {
                json!({
                    "pkg_id": j.pkg_id,
                    "cron_id": j.cron_id,
                    "expr": j.expr,
                    "handler": j.handler,
                    "job_uuid": j.job_uuid.to_string(),
                })
            })
            .collect();
        json!({ "count": entries.len(), "entries": entries })
    }
}

