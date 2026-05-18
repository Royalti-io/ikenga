//! OS-portable directory symlink helper shared by engine adapters that
//! materialize pkg asset folders via symlink (Claude Code today, Gemini and
//! Codex on the way per ADR-012 §10 phase 6).
//!
//! Lives here rather than `pkg::registries::engine_assets` because the
//! kernel-resident asset registry is now a fan-out shell over the adapters
//! — the actual symlink call happens inside each adapter. Future adapters
//! (Gemini, Codex) `pub(super) use` from this module so the cfg gates stay
//! in exactly one place.

use std::path::Path;

#[cfg(unix)]
pub(super) fn symlink_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
pub(super) fn symlink_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, target)
}
