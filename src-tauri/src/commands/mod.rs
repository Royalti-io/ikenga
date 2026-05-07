//! Tauri command surface. One file per domain. The full surface is locked in
//! during phase 1 even where the implementation is a stub — the typed wrappers
//! in `src/lib/tauri-cmd.ts` mirror this, so later phases just fill in the
//! Rust side.

pub mod actions;
pub mod backup;
pub mod chat;
pub mod claude;
pub mod claude_config;
pub mod db;
pub mod desktop;
pub mod fs;
pub mod iyke;
pub mod mbox;
pub mod pkg;
pub mod pkg_content;
pub mod pkg_mcp;
pub mod pty;
pub mod render;
pub mod screenshot;
pub mod secrets;
pub mod spike;
pub mod storyboard;
pub mod viewer;

pub use actions::pa_actions_run;
pub use backup::{backup_delete, backup_export, backup_import, backup_list};
pub use chat::{chat_cancel, chat_send};
pub use claude::{
    claude_chat_kill, claude_chat_send, claude_chat_spawn, claude_list_sessions,
    claude_read_jsonl, claude_spawn_session, ClaudeManager, ClaudeManagerState,
};
pub use claude_config::{
    claude_config_load, claude_config_read_file, claude_config_unwatch, claude_config_watch,
};
pub use db::{db_exec, db_query};
pub use desktop::set_dock_badge;
pub use fs::{
    fs_exists, fs_list, fs_mime, fs_read, fs_rename, fs_trash, fs_unwatch, fs_watch, fs_write,
};
pub use iyke::{
    iyke_dom_done, iyke_endpoint, iyke_log_push, iyke_network_push, iyke_query_cache_done,
    iyke_set_shell, iyke_wait_done, IykeRuntimeState,
};
pub use mbox::{mbox_ping, mbox_read_all};
pub use pkg::{
    pkg_db_diag, pkg_discover_workspace, pkg_install_from_path, pkg_kernel_status,
    pkg_preview_manifest, pkg_set_enabled, pkg_settings_get, pkg_settings_set, pkg_uninstall,
    KernelState, PkgSettingsState,
};
pub use pkg_content::{
    pkg_content_html, pkg_content_revoke, pkg_content_url, PkgContentState,
};
pub use pkg_mcp::{
    dev_bind_port, dev_release_port, pkg_mcp_call, pkg_supervisor_restart, SidecarSupervisorState,
};
pub use pty::{pty_kill, pty_resize, pty_spawn, pty_write};
pub use render::{render_cancel, render_composition, JobManagerState};
pub use screenshot::{
    screenshot_capture_done, screenshot_capture_failed, screenshot_get_config, screenshot_pane,
    screenshot_set_dir, screenshot_window, ScreenshotConfigState, ScreenshotConfigStateRef,
    ScreenshotPending, ScreenshotResult,
};
pub use secrets::{
    secrets_delete, secrets_get, secrets_import_dotenv, secrets_list_keys, secrets_set,
    secrets_vault_status, SecretsLock,
};
pub use spike::{spike_grant_fs_read, spike_setup_test_file};
pub use storyboard::{
    storyboard_export_json, storyboard_import_json, storyboard_list_concepts,
    storyboard_promote_rung, storyboard_render_still, StoryboardJobManager,
    StoryboardJobManagerState,
};
pub use viewer::{viewer_serve, viewer_stop};

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

/// Resolve `~/...` and env vars, then enforce allowlist. Returns the canonical
/// absolute path.
///
/// Allowlist (resolved at call time so dev/prod home dirs both work):
///   - `~/royalti-co/**`
///   - `~/.claude/projects/**`
///   - `~/.company/**`
pub fn resolve_allowlisted(input: &str) -> Result<PathBuf> {
    let expanded = shellexpand::full(input)
        .map(|c| c.into_owned())
        .map_err(|e| anyhow!("shellexpand failed: {e}"))?;
    let path = PathBuf::from(&expanded);
    let abs = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };

    // `canonicalize` requires the path to exist. For writes to new files we
    // canonicalize the parent and re-attach the filename so the allowlist
    // check still works.
    let canonical = if abs.exists() {
        abs.canonicalize()?
    } else if let Some(parent) = abs.parent() {
        if parent.exists() {
            let parent_canon = parent.canonicalize()?;
            match abs.file_name() {
                Some(name) => parent_canon.join(name),
                None => parent_canon,
            }
        } else {
            return Err(anyhow!("path does not exist: {}", abs.display()));
        }
    } else {
        return Err(anyhow!("path has no parent: {}", abs.display()));
    };

    if !is_allowed(&canonical)? {
        return Err(anyhow!(
            "path outside allowlist: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn is_allowed(path: &Path) -> Result<bool> {
    let home = match dirs_home() {
        Some(h) => h,
        None => return Err(anyhow!("could not resolve $HOME")),
    };
    let roots = [
        home.join("royalti-co"),
        home.join(".claude").join("projects"),
        home.join(".company"),
    ];
    for root in &roots {
        // Best-effort canonicalize the root; if it doesn't exist, fall back to
        // the lexical root.
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        if path.starts_with(&canon_root) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
