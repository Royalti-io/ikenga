//! Bun-compiled sidecar spawn helper.
//!
//! Replaces `tauri-plugin-shell::sidecar()` for the per-call binaries
//! (`pa-actions`, `pa-mbox`). The shell plugin's only job for those two
//! call-sites was: resolve the binary path next to `current_exe()`, spawn
//! it with piped stdio, stream `Stdout`/`Stderr`/`Terminated` events. We
//! replicate that with `tokio::process::Command` directly so the plugin
//! dependency can come out.
//!
//! Long-running supervised sidecars (hyperframes, video-studio, storyboard)
//! go through `crate::pkg::lifecycle::SidecarSupervisor` instead — that
//! path was never on the shell plugin.
//!
//! ## Path resolution
//!
//! Tauri's bundling system copies entries from `tauri.conf.json:externalBin`
//! into the same directory as the main executable, with the host triple
//! suffix stripped (so `pa-actions-x86_64-unknown-linux-gnu` becomes
//! `pa-actions` next to the desktop binary). The shell plugin's
//! `relative_command_path` does exactly this lookup. We mirror it here:
//! `current_exe().parent()/<name>`, with the same `/deps/` carve-out for
//! `cargo test` runs.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

/// Resolve a sidecar binary path next to the running executable. Mirrors
/// `tauri_plugin_shell::process::relative_command_path`.
pub fn resolve_sidecar_path(name: &str) -> Result<PathBuf> {
    let exe = std::env::current_exe().context("current_exe")?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| anyhow!("executable has no parent dir"))?;
    // `cargo test` puts the test binary under `target/debug/deps/`; the
    // sidecars sit one level up.
    let base = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    let mut path = base.join(name);
    if cfg!(windows) {
        let already_exe = path.extension().is_some_and(|ext| ext == "exe");
        if !already_exe {
            let mut s = path.into_os_string();
            s.push(".exe");
            path = PathBuf::from(s);
        }
    }
    Ok(path)
}

/// Handle to a spawned sidecar process. The caller drives the stdout
/// stream, optionally writes to stdin, and waits for exit.
pub struct SidecarChild {
    pub child: Child,
    pub stdout: Lines<BufReader<ChildStdout>>,
    pub stderr: Option<Lines<BufReader<ChildStderr>>>,
    pub stdin: Option<ChildStdin>,
}

impl SidecarChild {
    /// Send bytes (typically a single newline-terminated JSON line) to the
    /// child's stdin. Returns Err if stdin is already taken or closed.
    pub async fn write_stdin(&mut self, bytes: &[u8]) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("stdin already closed/taken"))?;
        stdin.write_all(bytes).await.context("write stdin")?;
        stdin.flush().await.ok();
        Ok(())
    }

    /// Best-effort kill. Returns Ok even if the child has already exited.
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

/// Spawn a bundled bun-compiled sidecar with piped stdio and line-buffered
/// stdout/stderr. `kill_on_drop` is set so a panicking caller doesn't leak
/// children. The caller decides timeout / completion semantics.
pub async fn spawn_sidecar(name: &str, args: &[String]) -> Result<SidecarChild> {
    let path = resolve_sidecar_path(name)?;
    let mut cmd = Command::new(&path);
    cmd.args(args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn sidecar `{}` at {}", name, path.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("sidecar `{name}` had no stdout"))?;
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    Ok(SidecarChild {
        child,
        stdout: BufReader::new(stdout).lines(),
        stderr: stderr.map(|s| BufReader::new(s).lines()),
        stdin,
    })
}
