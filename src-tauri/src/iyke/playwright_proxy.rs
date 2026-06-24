//! Reverse-proxy to the Playwright sidecar (ADR-018 / `plans/playwright-adoption`
//! WP-04). This is the replacement for the in-process chromiumoxide engine: the
//! shell no longer drives Chrome itself — it forwards the `engine=chrome` (later
//! `mode:attach|managed`) `/iyke/browser/*` requests to a long-lived Bun sidecar
//! (`@ikenga/sidecar-playwright-browser`) that owns the Playwright sessions.
//!
//! Lifecycle: lazy-spawn `bun run <sidecar.ts>` on the first chrome request,
//! read the `IKENGA_PW_READY {port}` line it prints, cache the port + child, and
//! reverse-proxy every browser verb to `http://127.0.0.1:{port}/iyke/browser/*`.
//! A small pane set records which `(pkg_id, pane_id)` are Playwright-backed so
//! the verb handlers route the same way the old `ChromeEngineRegistry::is_chrome`
//! did — without holding any browser state in-process.
//!
//! Not yet wired into `browser_handlers` (that atomic rewire is the cutover step,
//! gated G-CUTOVER + the WP-02 Attach validation); this module is the compiling
//! foundation.
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct PlaywrightProxy {
    inner: Mutex<Inner>,
    client: reqwest::Client,
    /// Absolute path to the sidecar entry (`.../playwright-browser/src/sidecar.ts`).
    sidecar_entry: PathBuf,
}

struct Inner {
    port: Option<u16>,
    child: Option<Child>,
    /// `(pkg_id, pane_id)` pairs currently backed by the Playwright sidecar.
    panes: HashSet<(String, String)>,
}

impl PlaywrightProxy {
    pub fn new(sidecar_entry: impl Into<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                port: None,
                child: None,
                panes: HashSet::new(),
            }),
            client: reqwest::Client::new(),
            sidecar_entry: sidecar_entry.into(),
        }
    }

    /// Spawn the sidecar if it isn't running yet and return its localhost port.
    async fn ensure_port(&self) -> Result<u16> {
        let mut g = self.inner.lock().await;
        if let Some(p) = g.port {
            return Ok(p);
        }
        let mut child = Command::new("bun")
            .arg("run")
            .arg(&self.sidecar_entry)
            .env("IKENGA_PW_HEADLESS", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn playwright sidecar: bun run {:?}", self.sidecar_entry))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sidecar stdout not captured"))?;
        let mut lines = BufReader::new(stdout).lines();

        // Read until the sidecar announces its bound port.
        let mut found: Option<u16> = None;
        while let Some(line) = lines.next_line().await.context("read sidecar stdout")? {
            if let Some(rest) = line.strip_prefix("IKENGA_PW_READY ") {
                found = rest.trim().parse().ok();
                break;
            }
        }
        let port = found.ok_or_else(|| anyhow!("sidecar exited before announcing a port"))?;
        tracing::info!("[playwright] sidecar ready on 127.0.0.1:{port}");
        g.port = Some(port);
        g.child = Some(child);
        Ok(port)
    }

    /// Forward a `/iyke/browser/*` POST verb to the sidecar; return its JSON body.
    pub async fn proxy_post(&self, path: &str, body: &Value) -> Result<Value> {
        let port = self.ensure_port().await?;
        let resp = self
            .client
            .post(format!("http://127.0.0.1:{port}{path}"))
            .header("content-type", "application/json")
            .body(serde_json::to_string(body).context("serialize proxy body")?)
            .send()
            .await
            .with_context(|| format!("proxy POST {path} to playwright sidecar"))?;
        let status = resp.status();
        let text = resp.text().await.context("read sidecar response")?;
        if !status.is_success() {
            return Err(anyhow!("sidecar {path} returned {status}: {text}"));
        }
        serde_json::from_str(&text).context("parse sidecar response")
    }

    /// Forward a `/iyke/browser/list`-style GET verb.
    pub async fn proxy_get(&self, path: &str, query: &str) -> Result<Value> {
        let port = self.ensure_port().await?;
        let resp = self
            .client
            .get(format!("http://127.0.0.1:{port}{path}?{query}"))
            .send()
            .await
            .with_context(|| format!("proxy GET {path} to playwright sidecar"))?;
        let text = resp.text().await.context("read sidecar response")?;
        serde_json::from_str(&text).context("parse sidecar response")
    }

    pub async fn track(&self, pkg_id: &str, pane_id: &str) {
        self.inner
            .lock()
            .await
            .panes
            .insert((pkg_id.to_string(), pane_id.to_string()));
    }

    pub async fn untrack(&self, pkg_id: &str, pane_id: &str) {
        self.inner
            .lock()
            .await
            .panes
            .remove(&(pkg_id.to_string(), pane_id.to_string()));
    }

    /// True iff this pane is Playwright-backed (the old `is_chrome` role).
    pub async fn has_pane(&self, pkg_id: &str, pane_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .panes
            .contains(&(pkg_id.to_string(), pane_id.to_string()))
    }

    pub async fn shutdown(&self) {
        let mut g = self.inner.lock().await;
        if let Some(mut child) = g.child.take() {
            let _ = child.start_kill();
        }
        g.port = None;
        g.panes.clear();
    }
}
