//! Desktop / OS-integration commands. cfg-gated bodies — Linux call sites
//! are no-ops, Mac uses AppKit via objc2.
//!
//! Mac code paths are unverified-on-Linux-session per Phase 8 spec; verify on
//! next-Mac-boot. The objc2 calls follow the standard NSApp.dockTile API.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Set the macOS dock-tile badge. `label = None` clears it.
///
/// On Linux this is a no-op. Frontend may call unconditionally with the
/// unread inbox count.
#[tauri::command]
pub fn set_dock_badge(_app: AppHandle, label: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let label = label;
        _app.run_on_main_thread(move || {
            use objc2::rc::autoreleasepool;
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            use objc2_foundation::NSString;

            autoreleasepool(|_| {
                // Safe: we're on the main thread inside run_on_main_thread.
                let mtm = unsafe { MainThreadMarker::new_unchecked() };
                let app = NSApplication::sharedApplication(mtm);
                let tile = unsafe { app.dockTile() };
                let ns = label.as_deref().map(NSString::from_str);
                unsafe { tile.setBadgeLabel(ns.as_deref()) };
            });
        })
        .map_err(|e| format!("dock badge dispatch: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label;
    }
    Ok(())
}

/// Path + presence info for the bundled iyke-mcp binary. The settings panel
/// uses this to render a copy-to-clipboard config snippet pointing at the
/// absolute path on disk so external MCP clients (Claude Desktop, Cursor)
/// can spawn the binary without going through bun / npm.
///
/// Two candidate roots, mirroring the kernel's `install_builtins` logic:
/// 1. dev: `$CARGO_MANIFEST_DIR/resources` — debug builds read from the
///    source tree so live-edits are immediate.
/// 2. prod: `app.path().resource_dir()` — the Tauri-bundled resource path.
///
/// Returns `present: false` when the binary is missing (build not yet run,
/// or strip-down deleted it). The frontend renders a softer "build pending"
/// note instead of a copy block.
#[derive(Serialize)]
pub struct IykeMcpInfo {
    /// Absolute path the user's MCP client should be configured against.
    /// Empty string when the resource dir can't be resolved at all.
    pub path: String,
    /// True when the file actually exists at `path`. False after a clean
    /// build that hasn't run `iyke:mcp:build` yet.
    pub present: bool,
    /// Surface the source of `path` so the panel can hint dev-mode users.
    pub source: String, // "dev-tree" | "resource-dir" | "unknown"
}

#[tauri::command]
pub fn iyke_mcp_info(app: AppHandle) -> IykeMcpInfo {
    let rel = std::path::Path::new("builtin-pkgs")
        .join("com.ikenga.mcp-iyke")
        .join("bin")
        .join("iyke-mcp");

    // Dev-tree first: faster iteration on the binary without rebuilding the
    // Tauri bundle. Mirrors `lib.rs:install_builtins` candidate ordering.
    #[cfg(debug_assertions)]
    {
        let dev_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let dev_bin = dev_root.join(&rel);
        if dev_bin.exists() {
            return IykeMcpInfo {
                path: dev_bin.display().to_string(),
                present: true,
                source: "dev-tree".into(),
            };
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod_bin = resource_dir.join(&rel);
        let present = prod_bin.exists();
        return IykeMcpInfo {
            path: prod_bin.display().to_string(),
            present,
            source: "resource-dir".into(),
        };
    }

    IykeMcpInfo {
        path: String::new(),
        present: false,
        source: "unknown".into(),
    }
}
