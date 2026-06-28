//! Spike: verify Tauri 2's dynamic ACL works for the package kernel design.
//!
//! Background: the kernel needs to grant per-package permissions at install
//! time without regenerating capability files or restarting the app.
//! Tauri 2.11 ships `Manager::add_capability` (default `dynamic-acl` feature)
//! that should support this. This command exercises the API end-to-end.
//!
//! Test recipe (devtools console, dev mode):
//!
//!   const fs = window.__TAURI__.fs;
//!   const inv = window.__TAURI__.core.invoke;
//!   // 1. Without grant: reading /tmp/spike-test.txt should fail with
//!   //    "fs.read_text_file not allowed on path /tmp/spike-test.txt".
//!   await fs.readTextFile('/tmp/spike-test.txt').catch(e => 'BLOCKED: ' + e);
//!   // 2. Grant a runtime capability scoped to that path.
//!   await inv('spike_grant_fs_read', {
//!     capabilityId: 'spike.fs-read.tmp',
//!     path: '/tmp/spike-test.txt'
//!   });
//!   // 3. Read should now succeed.
//!   await fs.readTextFile('/tmp/spike-test.txt');
//!
//! If step 1 fails (blocked) and step 3 succeeds (returns the file body) the
//! dynamic ACL path is real and the package kernel can build on it.

use serde::Serialize;
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager};

#[derive(Serialize)]
struct FsScopeEntry {
    path: String,
}

#[tauri::command]
pub fn spike_grant_fs_read(
    app: AppHandle,
    capability_id: String,
    path: String,
) -> Result<String, String> {
    let cap = CapabilityBuilder::new(&capability_id)
        // Debug ACL spike — grants to the PRIMARY window only (single-window
        // probe). TODO(multi-window): n/a for this harness.
        .window("main")
        // plugin-fs splits text/binary reads into separate permissions:
        // `read_text_file` checks `fs:allow-read-text-file`, NOT
        // `fs:allow-read-file`. Important constraint for the kernel's
        // permission-registry mapper.
        .permission_scoped(
            "fs:allow-read-text-file",
            vec![FsScopeEntry { path: path.clone() }],
            Vec::<FsScopeEntry>::new(),
        );

    app.add_capability(cap)
        .map_err(|e| format!("add_capability failed: {e}"))?;

    let msg = format!("granted fs:allow-read-text-file scoped to {path} (cap_id={capability_id})");
    log::info!("spike: {msg}");
    Ok(msg)
}

/// Stage a test file via std::fs (bypasses Tauri ACL) so the spike route can
/// use a fresh path per mount and avoid leaking grants across runs.
#[tauri::command]
pub fn spike_setup_test_file(path: String, body: String) -> Result<(), String> {
    std::fs::write(&path, body).map_err(|e| format!("write {path}: {e}"))?;
    log::info!("spike: setup wrote {path}");
    Ok(())
}
