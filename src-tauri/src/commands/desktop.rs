//! Desktop / OS-integration commands. cfg-gated bodies — currently a no-op
//! across all platforms.
//!
//! The macOS dock-tile-badge code (NSApp.dockTile via objc2) was removed
//! when the strip-down hit Mac CI: the resolved objc2 v0.5 doesn't export
//! `MainThreadMarker` at the path the code expected, and the feature was
//! never functionally verified on a Mac anyway (per the prior README
//! caveat). Re-introduce when there's a Mac dev session to validate
//! against — pin objc2 to a known-working version then.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Set the macOS dock-tile badge. `label = None` clears it.
///
/// Currently a no-op on every platform (see module doc). Kept as a Tauri
/// command so the frontend's unconditional `setDockBadge(unreadCount)`
/// call still resolves cleanly — re-implement the body when Mac support
/// is verified.
#[tauri::command]
pub fn set_dock_badge(_app: AppHandle, label: Option<String>) -> Result<(), String> {
    let _ = label;
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
