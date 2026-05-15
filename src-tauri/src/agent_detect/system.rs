//! `detect_system` — the high-level "is this machine ready for Ikenga?"
//! check the first-run wizard renders on its System step.
//!
//! Designed to be cheap: no subprocesses, no network. Disk-free uses
//! `sysinfo`'s `Disks` API (POSIX `statvfs` / Windows `GetDiskFreeSpaceEx`
//! under the hood). Writability is verified by a hidden tempfile so we
//! catch read-only mounts / SELinux-denied dirs the user couldn't ssh
//! their way out of.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::Disks;

use crate::vault_key;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckLevel {
    Pass,
    Warn,
    Fail,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemCheck {
    pub id: String,
    pub level: CheckLevel,
    pub message: String,
    pub fix_hint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SystemReport {
    pub os: String,
    pub arch: String,
    pub disk_free_gb: u64,
    pub app_data_dir: String,
    pub app_data_writable: bool,
    pub vault_key_present: bool,
    pub claude_projects_dir_present: bool,
    pub checks: Vec<SystemCheck>,
}

/// Public entry point. `app_data_dir` is the value Tauri's
/// `app.path().app_data_dir()` resolves to — passed in so the command
/// handler doesn't have to teach this module about `AppHandle`.
pub fn build_report(app_data_dir: PathBuf) -> SystemReport {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let app_data_writable = probe_writable(&app_data_dir);
    let vault_key_present = vault_key_exists(&app_data_dir);
    let claude_projects_dir = claude_projects_path();
    let claude_projects_dir_present = claude_projects_dir
        .as_ref()
        .map(|p| p.is_dir())
        .unwrap_or(false);
    let disk_free_gb = disk_free_gb_for(&app_data_dir);

    let mut checks = Vec::new();

    checks.push(SystemCheck {
        id: "app_data_dir".into(),
        level: if app_data_writable {
            CheckLevel::Pass
        } else {
            CheckLevel::Fail
        },
        message: if app_data_writable {
            format!("App data dir is writable ({})", app_data_dir.display())
        } else {
            format!("App data dir is not writable: {}", app_data_dir.display())
        },
        fix_hint: if app_data_writable {
            None
        } else {
            Some(
                "Check filesystem permissions on the app-data directory. \
                 Ikenga writes SQLite + Stronghold + logs here."
                    .into(),
            )
        },
    });

    checks.push(SystemCheck {
        id: "vault_key".into(),
        level: if vault_key_present {
            CheckLevel::Pass
        } else {
            CheckLevel::Warn
        },
        message: if vault_key_present {
            "Stronghold vault key is bootstrapped".into()
        } else {
            "Stronghold vault key not yet generated".into()
        },
        fix_hint: if vault_key_present {
            None
        } else {
            Some(
                "The key is created automatically on first launch; this \
                 warning resolves itself after the wizard finishes."
                    .into(),
            )
        },
    });

    checks.push(SystemCheck {
        id: "disk_free".into(),
        level: if disk_free_gb >= 5 {
            CheckLevel::Pass
        } else if disk_free_gb >= 1 {
            CheckLevel::Warn
        } else {
            CheckLevel::Fail
        },
        message: format!("{disk_free_gb} GB free on the app-data volume"),
        fix_hint: if disk_free_gb >= 5 {
            None
        } else {
            Some("Free up disk before installing packages. We recommend at least 5 GB.".into())
        },
    });

    checks.push(SystemCheck {
        id: "claude_projects".into(),
        level: if claude_projects_dir_present {
            CheckLevel::Pass
        } else {
            CheckLevel::Warn
        },
        message: if claude_projects_dir_present {
            format!(
                "Claude projects dir present: {}",
                claude_projects_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            )
        } else {
            "~/.claude/projects/ not found".into()
        },
        fix_hint: if claude_projects_dir_present {
            None
        } else {
            Some(
                "No previous Claude Code sessions detected. That's fine — \
                 we'll create the dir when you run a session for the first time."
                    .into(),
            )
        },
    });

    SystemReport {
        os,
        arch,
        disk_free_gb,
        app_data_dir: app_data_dir.display().to_string(),
        app_data_writable,
        vault_key_present,
        claude_projects_dir_present,
        checks,
    }
}

fn probe_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".ikenga-writable-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            // Best-effort cleanup; if removal fails we still consider the
            // dir writable (probably an antivirus race, not a permission
            // problem).
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn vault_key_exists(app_data_dir: &Path) -> bool {
    // Mirror vault_key::vault_key_path() — but we don't expose that helper
    // publicly, and we don't want to *create* the dir as a side effect
    // here. So replicate the filename only.
    let _ = vault_key::keychain_backend(); // touch to avoid dead-imports lint
    app_data_dir.join(".vault-key").is_file()
}

fn claude_projects_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join(".claude").join("projects"))
}

fn disk_free_gb_for(target: &Path) -> u64 {
    // `Disks::new_with_refreshed_list()` enumerates mounted disks. We want
    // the longest mount-point prefix-match for `target` — that's the volume
    // the file would live on.
    let disks = Disks::new_with_refreshed_list();
    let canonical = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());

    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if canonical.starts_with(mount) {
            let len = mount.as_os_str().len();
            let bytes = disk.available_space();
            match best {
                Some((cur_len, _)) if cur_len >= len => {}
                _ => best = Some((len, bytes)),
            }
        }
    }
    best.map(|(_, bytes)| bytes / 1_073_741_824).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_has_expected_check_ids() {
        let tmp = std::env::temp_dir().join("ikenga-detect-test");
        let report = build_report(tmp.clone());
        let ids: std::collections::HashSet<_> =
            report.checks.iter().map(|c| c.id.as_str()).collect();
        for id in ["app_data_dir", "vault_key", "disk_free", "claude_projects"] {
            assert!(ids.contains(id), "missing check {id}");
        }
        // Cleanup probe artifact (build_report wrote one).
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn writable_probe_recognises_tempdir() {
        let tmp = std::env::temp_dir().join("ikenga-detect-write-test");
        assert!(probe_writable(&tmp));
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn os_arch_reflect_target() {
        let tmp = std::env::temp_dir().join("ikenga-detect-os-test");
        let report = build_report(tmp.clone());
        assert!(matches!(
            report.os.as_str(),
            "macos" | "linux" | "windows" | "freebsd" | "openbsd" | "netbsd" | "dragonfly"
        ));
        assert!(!report.arch.is_empty());
        let _ = std::fs::remove_dir_all(tmp);
    }
}
