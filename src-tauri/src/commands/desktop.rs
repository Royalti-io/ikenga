//! Desktop / OS-integration commands. cfg-gated bodies — Linux call sites
//! are no-ops, Mac uses AppKit via objc2.
//!
//! Mac code paths are unverified-on-Linux-session per Phase 8 spec; verify on
//! next-Mac-boot. The objc2 calls follow the standard NSApp.dockTile API.

use tauri::AppHandle;

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
