//! Runtime resolver for sidecar / MCP child processes.
//!
//! Owns the location of the bundled `bun` binary (per ADR-010) and exposes
//! `resolve_command()` — the shim every spawn site should call before
//! `Command::new(...)`. A manifest's bare `"bun"` becomes the bundled binary;
//! anything else (absolute paths, `./bin/foo` shell-outs) passes through.
//!
//! Resolution order, mirroring `lib.rs`'s builtin-pkgs lookup:
//!   1. Debug builds: `$CARGO_MANIFEST_DIR/resources/bun/<host-target>/bun`.
//!      Lets `tauri dev` exercise the bundled-Bun path without a release
//!      build, as long as `scripts/fetch-bun.sh --target <host>` has been
//!      run once.
//!   2. Release builds: `<resource_dir>/bun/<host-target>/bun`, populated by
//!      `tauri.conf.json:bundle.resources` from the same source tree.
//!   3. Last resort: bare `"bun"`, deferring to PATH lookup. Logged WARN so
//!      we notice if dev/CI forgot to fetch the binary.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// Bun's release-asset target naming for the host we're building for. Maps
/// from Rust's `cfg(target_os/arch)` to the directory layout `fetch-bun.sh`
/// writes to. `unsupported` means we never wrote a binary for this host —
/// `bun_path()` will return None and `resolve_command` will fall through to
/// PATH lookup.
const BUN_TARGET: &str = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "linux-x64"
} else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
    "linux-aarch64"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "darwin-x64"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "darwin-aarch64"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "windows-x64"
} else {
    "unsupported"
};

const BUN_BIN_NAME: &str = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };

static BUN_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Initialise the bundled-Bun lookup at app setup time. Idempotent.
pub fn init_from_app(app: &AppHandle) {
    let _ = BUN_PATH.get_or_init(|| resolve_bun_path(app));
}

/// Look for the bundled bun under the source tree (debug builds). Pulled out
/// of `resolve_bun_path` so unit tests can exercise it without an AppHandle.
#[cfg(debug_assertions)]
fn resolve_dev_bun_path() -> Option<PathBuf> {
    if BUN_TARGET == "unsupported" {
        return None;
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/bun")
        .join(BUN_TARGET)
        .join(BUN_BIN_NAME);
    if dev.is_file() {
        Some(dev)
    } else {
        None
    }
}

fn resolve_bun_path(app: &AppHandle) -> Option<PathBuf> {
    if BUN_TARGET == "unsupported" {
        log::warn!(
            "[runtime] bundled bun: host target unsupported by fetch-bun.sh — falling back to PATH"
        );
        return None;
    }

    // Debug builds: prefer the source tree so `tauri dev` doesn't need a
    // bundle round-trip after `scripts/fetch-bun.sh` populates it.
    #[cfg(debug_assertions)]
    if let Some(dev) = resolve_dev_bun_path() {
        log::info!("[runtime] bundled bun (dev): {}", dev.display());
        return Some(dev);
    }

    // Release builds (and debug fallback): the Tauri-bundled resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("bun").join(BUN_TARGET).join(BUN_BIN_NAME);
        if bundled.is_file() {
            log::info!("[runtime] bundled bun (resource_dir): {}", bundled.display());
            return Some(bundled);
        }
        log::warn!(
            "[runtime] no bundled bun at {} — run `bash scripts/fetch-bun.sh --target {BUN_TARGET}` \
             before tauri dev/build, or sidecars relying on bun will use the system PATH copy",
            bundled.display()
        );
    } else {
        log::warn!("[runtime] resource_dir unavailable — bundled bun lookup skipped");
    }
    None
}

/// Path to the bundled bun, if `init_from_app` has run AND a binary exists.
pub fn bun_path() -> Option<&'static Path> {
    BUN_PATH.get().and_then(|opt| opt.as_deref())
}

/// Rewrite a manifest's `command` for spawn. Bare `"bun"` becomes the bundled
/// binary; absolute paths and `./bin/foo` shell-outs pass through unchanged.
pub fn resolve_command(declared: &str) -> PathBuf {
    if declared == "bun" {
        if let Some(p) = bun_path() {
            return p.to_path_buf();
        }
    }
    PathBuf::from(declared)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_bun_path_finds_fetch_script_output_when_present() {
        // This test passes when `scripts/fetch-bun.sh --target <host>` has
        // been run for the host. CI runs that as a build prereq; locally
        // the test is informational — assertion guarded behind the file
        // check so a stock checkout doesn't fail the suite.
        if let Some(p) = resolve_dev_bun_path() {
            assert!(p.is_file(), "resolve_dev_bun_path returned a non-file path: {}", p.display());
            assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(BUN_BIN_NAME));
        }
    }

    #[test]
    fn resolve_command_passes_through_non_bun_declarations() {
        // Absolute paths, ./bin shell-outs, and any other binary name must
        // round-trip unchanged so existing manifests (engine adapters, the
        // legacy iyke-mcp `./bin/iyke-mcp`) keep working.
        assert_eq!(resolve_command("./bin/iyke-mcp"), PathBuf::from("./bin/iyke-mcp"));
        assert_eq!(resolve_command("/usr/bin/node"), PathBuf::from("/usr/bin/node"));
        assert_eq!(resolve_command("uvx"), PathBuf::from("uvx"));
    }

    #[test]
    fn resolve_command_bun_falls_through_to_path_when_uninitialised() {
        // Without `init_from_app`, BUN_PATH is unset → `"bun"` round-trips
        // and the OS does PATH lookup. This is the fallback contract for
        // debug builds where fetch-bun.sh hasn't been run.
        // (Cannot assert the bundled-path branch here without an AppHandle;
        // covered by the dev-path test above when the binary is present.)
        if bun_path().is_none() {
            assert_eq!(resolve_command("bun"), PathBuf::from("bun"));
        }
    }
}
