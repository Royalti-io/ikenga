//! Claude assets registry — installs package-contributed skills, commands, and
//! agents into the user's `~/.claude/` tree.
//!
//! Manifest fields each point at a folder inside the package install dir:
//!   - `skills`   → copied/linked into `~/.claude/skills/<pkg-slug>/`
//!   - `commands` → `~/.claude/commands/<pkg-slug>/`
//!   - `agents`   → `~/.claude/agents/<pkg-slug>/`
//!
//! v1 implementation strategy: **symlink** the source dir into the target.
//! Tradeoff:
//!   - Symlinks let the package author edit source files and have changes
//!     visible to Claude Code immediately — exactly what the dev loop needs.
//!   - Copies would survive the package being moved or unmounted, but for
//!     personal-use installs the package dir is on the same filesystem and
//!     stays put.
//! If the symlink already exists and points at the right target, register is
//! a no-op (idempotent boot replay).
//!
//! Snapshot shape: `{ entries: [{pkg_id, kind, source, target}, ...] }`.
//! Uninstall removes only the symlinks this registry created — content the
//! user has placed under `~/.claude/skills/` directly is not touched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::pkg::manifest::Package;
use crate::pkg::registry::Registry;

#[derive(Debug, Clone, Serialize)]
pub struct AssetEntry {
    pub pkg_id: String,
    /// "skills" | "commands" | "agents"
    pub kind: String,
    pub source: String,
    pub target: String,
}

#[derive(Default)]
pub struct ClaudeAssetsRegistry {
    /// `pkg_id` → entries we created. Uninstall walks this list and removes
    /// each target. Empty for packages that declare no asset blocks.
    entries: RwLock<HashMap<String, Vec<AssetEntry>>>,
}

impl ClaudeAssetsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<AssetEntry> {
        self.entries
            .read()
            .map(|g| g.values().flatten().cloned().collect())
            .unwrap_or_default()
    }

    fn claude_dir() -> Result<PathBuf> {
        let home = std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME not set"))?;
        Ok(PathBuf::from(home).join(".claude"))
    }

    /// Install one symlink. If `target` exists and already points at `source`,
    /// returns the entry without touching the filesystem (idempotent). If it
    /// exists pointing somewhere else, returns an error rather than blowing
    /// the user's config away.
    fn install_symlink(pkg: &Package, kind: &str, rel: &str) -> Result<AssetEntry> {
        let source = pkg
            .resolve_relative(rel)
            .with_context(|| format!("resolve `{kind}` source `{rel}`"))?;
        if !source.is_dir() {
            return Err(anyhow!(
                "`{kind}` source `{}` is not a directory",
                source.display()
            ));
        }
        let claude = Self::claude_dir()?;
        let parent = claude.join(kind);
        std::fs::create_dir_all(&parent).with_context(|| format!("mkdir {}", parent.display()))?;
        let target = parent.join(pkg.slug());

        // Resolve any existing entry at the target. read_link errors if the
        // path isn't a symlink, so a real dir there means the user has hand-
        // crafted state — refuse to clobber.
        match std::fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let current = std::fs::read_link(&target).ok();
                    if current.as_deref() == Some(source.as_path()) {
                        return Ok(AssetEntry {
                            pkg_id: pkg.manifest.id.clone(),
                            kind: kind.to_string(),
                            source: source.display().to_string(),
                            target: target.display().to_string(),
                        });
                    }
                    // Stale symlink (probably from a prior install path) —
                    // safe to replace.
                    std::fs::remove_file(&target)
                        .with_context(|| format!("rm stale symlink {}", target.display()))?;
                } else {
                    return Err(anyhow!(
                        "`{}` exists and is not a symlink — refusing to overwrite",
                        target.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow!("stat {}: {e}", target.display())),
        }

        symlink_dir(&source, &target)
            .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))?;

        Ok(AssetEntry {
            pkg_id: pkg.manifest.id.clone(),
            kind: kind.to_string(),
            source: source.display().to_string(),
            target: target.display().to_string(),
        })
    }

    fn remove_target(target: &str) {
        let path = Path::new(target);
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if let Err(e) = std::fs::remove_file(path) {
                    log::warn!("[pkg.claude_assets] rm symlink {target}: {e}");
                }
            }
            Ok(_) => {
                log::warn!(
                    "[pkg.claude_assets] target `{target}` is not a symlink — skipping (user-managed?)"
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[pkg.claude_assets] stat {target}: {e}"),
        }
    }
}

#[cfg(unix)]
fn symlink_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
fn symlink_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, target)
}

impl Registry for ClaudeAssetsRegistry {
    fn name(&self) -> &'static str {
        "claude_assets"
    }

    fn register(&self, pkg: &Package) -> Result<()> {
        let mut new_entries: Vec<AssetEntry> = Vec::new();

        // Collect (kind, rel-path) from the three optional manifest fields.
        let blocks: [(&str, &Option<String>); 3] = [
            ("skills", &pkg.manifest.skills),
            ("commands", &pkg.manifest.commands),
            ("agents", &pkg.manifest.agents),
        ];

        for (kind, maybe_rel) in blocks {
            let rel = match maybe_rel {
                Some(r) => r,
                None => continue,
            };
            let entry = Self::install_symlink(pkg, kind, rel).with_context(|| {
                format!("pkg `{}` install `{kind}` from `{rel}`", pkg.manifest.id)
            })?;
            new_entries.push(entry);
        }

        if new_entries.is_empty() {
            return Ok(());
        }

        let mut map = self
            .entries
            .write()
            .map_err(|_| anyhow!("claude_assets lock poisoned"))?;
        map.insert(pkg.manifest.id.clone(), new_entries);
        Ok(())
    }

    fn unregister(&self, pkg_id: &str) -> Result<()> {
        let to_remove: Vec<AssetEntry> = self
            .entries
            .write()
            .map_err(|_| anyhow!("claude_assets lock poisoned"))?
            .remove(pkg_id)
            .unwrap_or_default();
        for e in to_remove {
            Self::remove_target(&e.target);
        }
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let entries = self.list();
        json!({ "count": entries.len(), "entries": entries })
    }
}
