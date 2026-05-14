//! Tauri command surface. One file per domain. The full surface is locked in
//! during phase 1 even where the implementation is a stub — the typed wrappers
//! in `src/lib/tauri-cmd.ts` mirror this, so later phases just fill in the
//! Rust side.

pub mod acp;
pub mod activity_bar;
pub mod backup;
#[cfg(debug_assertions)]
pub mod bg_spike;
pub mod claude;
pub mod claude_config;
pub mod db;
pub mod desktop;
pub mod fs;
pub mod fs_roots;
pub mod iyke;
pub mod pkg;
pub mod pkg_content;
pub mod pkg_mcp;
pub mod pkg_sidecar;
pub mod pkg_webview;
pub mod projects;
pub mod pty;
pub mod screenshot;
pub mod secrets;
pub mod settings_kv;
pub mod spike;
pub mod supabase_config;
pub mod trust;
pub mod viewer;

pub use acp::{
    acp_cancel, acp_fork_session, acp_initialize, acp_load_session, acp_new_session, acp_prompt,
    acp_respond_permission, acp_set_effort, acp_set_mode, acp_set_model,
};
pub use activity_bar::{
    activity_pins_add, activity_pins_list, activity_pins_remove, activity_pins_reorder,
    activity_pins_resolve_artifact, activity_pins_touch_open, activity_sections_create,
    activity_sections_list, activity_sections_remove, activity_sections_update,
};
pub use backup::{backup_delete, backup_export, backup_import, backup_list};
#[cfg(debug_assertions)]
pub use bg_spike::{bg_spike_reply, bg_spike_run, new_state as new_bg_spike_state};
pub use claude::{
    chat_thread_move, chat_threads_list_by_project, claude_list_sessions, claude_read_jsonl,
    session_cancel, session_destroy, session_destroy_all, session_ensure, session_send,
    session_tool_result,
};
pub use claude_config::{
    claude_asset_list_pins, claude_asset_pin, claude_asset_unpin, claude_assets_discover,
    claude_config_load, claude_config_read_file, claude_config_unwatch, claude_config_watch,
};
pub use db::{db_exec, db_query};
pub use desktop::{iyke_mcp_info, set_dock_badge, IykeMcpInfo};
pub use fs::{
    fs_exists, fs_list, fs_mime, fs_read, fs_rename, fs_trash, fs_unwatch, fs_watch, fs_write,
};
pub use fs_roots::{fs_roots_add, fs_roots_list, fs_roots_remove, fs_roots_reset};
pub use iyke::{
    iyke_dom_done, iyke_endpoint, iyke_log_push, iyke_network_push, iyke_query_cache_done,
    iyke_set_shell, iyke_wait_done, IykeRuntimeState,
};
pub use pkg::{
    pkg_db_diag, pkg_discover_workspace, pkg_install_from_path, pkg_install_from_registry,
    pkg_kernel_status, pkg_preview_manifest, pkg_set_enabled, pkg_set_scope, pkg_settings_get,
    pkg_settings_set, pkg_uninstall, KernelState, PkgSettingsState,
};
pub use pkg_content::{pkg_content_html, pkg_content_revoke, pkg_content_url, PkgContentState};
pub use pkg_mcp::{
    dev_bind_port, dev_release_port, pkg_mcp_call, pkg_supervisor_restart, SidecarSupervisorState,
};
pub use pkg_sidecar::{pkg_sidecar_call, SidecarsRegistryState};
pub use pkg_webview::{
    pkg_webview_create, pkg_webview_destroy, pkg_webview_navigate, pkg_webview_set_rect,
    WebviewPanesState,
};
pub use projects::{
    project_archive, project_create, project_get_active, project_list, project_set_active,
    project_update,
};
pub use pty::{pty_kill, pty_resize, pty_spawn, pty_write};
pub use screenshot::{
    screenshot_capture_done, screenshot_capture_failed, screenshot_get_config, screenshot_pane,
    screenshot_set_dir, screenshot_window, ScreenshotConfigState, ScreenshotConfigStateRef,
    ScreenshotPending, ScreenshotResult,
};
pub use secrets::{
    secrets_delete, secrets_delete_scoped, secrets_get, secrets_get_scoped, secrets_list_keys,
    secrets_list_keys_scoped, secrets_set, secrets_set_scoped, secrets_vault_status, SecretsLock,
};
pub use settings_kv::{settings_clear_all, settings_get, settings_get_all, settings_set};
pub use spike::{spike_grant_fs_read, spike_setup_test_file};
pub use supabase_config::{supabase_config_clear, supabase_config_get, supabase_config_set};
pub use trust::{pkg_trust_grant, pkg_trust_list, pkg_trust_preview, pkg_trust_revoke};
pub use viewer::{viewer_port, viewer_serve, viewer_stop};

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

/// Resolve `~/...` and env vars, then enforce the user-configurable allowlist
/// (see `crate::fs_roots`). Returns the canonical absolute path.
///
/// The active root set lives in a process-global `OnceLock` set by
/// `lib.rs::run` during `.setup()`, so this function does not need to thread
/// `tauri::State` through every fs command + the viewer.
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
        return Err(anyhow!("path outside allowlist: {}", canonical.display()));
    }
    Ok(canonical)
}

fn is_allowed(path: &Path) -> Result<bool> {
    let roots = crate::fs_roots::current().ok_or_else(|| anyhow!("fs_roots not initialized"))?;
    Ok(roots.is_allowed(path))
}
