//! Gemini CLI engine adapter — ADR-012 Track G Rust mirror of the TS
//! `GeminiEngineAdapter` in `ikenga-pkgs/packages/engine/gemini/src/
//! portability.ts`. Produces byte-equivalent on-disk results.
//!
//! On-disk layout (ADR §1):
//!   - MCP:      `~/.gemini/settings.json` `mcpServers.ikenga.<slug>.<name>`
//!               (JSON; same shape as the Claude adapter — including the
//!               `disabled: true` long-lived rule + strict secret-pattern
//!               refusal).
//!   - Skills:   folder symlink `~/.gemini/extensions/<pkg-slug>/` → source.
//!   - Agents:   folder symlink `~/.gemini/agents/<pkg-slug>/` → source
//!               (Gemini consumes canonical MD+YAML directly).
//!   - Commands: per-file MD → TOML transcode at
//!               `~/.gemini/commands/<pkg-slug>/<basename>.toml`. Atomic
//!               write per file. Idempotency: byte-equal output → skip.
//!               Reports ONE aggregate entry (the per-pkg directory) so the
//!               kernel's `engine_assets` registry can slug-recover and
//!               `rm -rf` on uninstall.
//!
//! Most of this file is a near-clone of `claude_code.rs` with a different
//! home dir and a commands-transcode pass. The TS counterpart is the source
//! of truth for behavior; this Rust adapter just needs to produce the same
//! on-disk results so the kernel can fan installs / uninstalls through it.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::symlink::symlink_dir;
use super::transcoder::md_to_gemini_command_toml;
use crate::pkg::engine_adapter::{EngineAdapter, InstallReport};
use crate::pkg::manifest::McpServer;

const IKENGA_SECRET_PREFIX: &str = "${IKENGA_SECRET:";

/// Cached secret-pattern regex. Same shape as the Claude adapter's literal.
fn secret_key_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)$")
            .expect("static regex compiles")
    })
}

pub struct GeminiAdapter;

impl GeminiAdapter {
    pub fn new() -> Self {
        Self
    }

    fn gemini_home() -> Result<PathBuf> {
        let home = crate::platform::home_dir()
            .ok_or_else(|| anyhow!("could not resolve home directory (HOME / USERPROFILE unset)"))?;
        Ok(home.join(".gemini"))
    }

    fn settings_path() -> Result<PathBuf> {
        Ok(Self::gemini_home()?.join("settings.json"))
    }

    fn mcp_key(pkg_slug: &str, server_name: &str) -> String {
        format!("ikenga.{pkg_slug}.{server_name}")
    }

    /// `~/.gemini/<kind>` — parent directory the per-pkg symlink lives in.
    /// `kind` is `extensions` (for skills) or `agents`.
    fn assets_dir(kind: &str) -> Result<PathBuf> {
        Ok(Self::gemini_home()?.join(kind))
    }

    /// `~/.gemini/<kind>/<pkg-slug>` — the symlink target.
    fn asset_target(kind: &str, pkg_slug: &str) -> Result<PathBuf> {
        Ok(Self::assets_dir(kind)?.join(pkg_slug))
    }

    /// `~/.gemini/commands/<pkg-slug>` — the per-pkg commands output dir.
    fn commands_dir(pkg_slug: &str) -> Result<PathBuf> {
        Ok(Self::gemini_home()?.join("commands").join(pkg_slug))
    }

    /// Folder-symlink installer — same shape as the Claude adapter's
    /// `install_asset_folder`. Used for both skills (`extensions`) and
    /// agents.
    fn install_asset_folder(
        kind: &str,
        source: &Path,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        if !source.is_dir() {
            return Err(anyhow!(
                "`{kind}` source `{}` is not a directory",
                source.display()
            ));
        }
        let parent = Self::assets_dir(kind)?;
        std::fs::create_dir_all(&parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;
        let target = parent.join(pkg_slug);

        let mut report = InstallReport::default();

        match std::fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let current = std::fs::read_link(&target).ok();
                    if current.as_deref() == Some(source) {
                        report.skipped.push(target.display().to_string());
                        return Ok(report);
                    }
                    std::fs::remove_file(&target)
                        .with_context(|| format!("rm stale symlink {}", target.display()))?;
                    report
                        .warnings
                        .push(format!("replaced stale symlink at {}", target.display()));
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

        symlink_dir(source, &target)
            .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))?;
        report.wrote.push(target.display().to_string());
        Ok(report)
    }

    fn uninstall_asset_folder(kind: &str, pkg_slug: &str) -> Result<()> {
        let target = Self::asset_target(kind, pkg_slug)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if let Err(e) = std::fs::remove_file(&target) {
                    log::warn!(
                        "[engine.gemini] rm symlink {}: {e}",
                        target.display()
                    );
                }
            }
            Ok(_) => {
                log::warn!(
                    "[engine.gemini] target `{}` is not a symlink — skipping (user-managed?)",
                    target.display()
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "[engine.gemini] stat {}: {e}",
                target.display()
            ),
        }
        Ok(())
    }

    /// Walk `source` for `.md` files, transcode each to TOML, and write to
    /// `~/.gemini/commands/<slug>/<basename>.toml`. Returns ONE aggregated
    /// report whose `wrote` field is the per-pkg directory (slug-recovery
    /// convention — Track P).
    fn install_commands_transcoded(source: &Path, pkg_slug: &str) -> Result<InstallReport> {
        if !source.is_dir() {
            return Err(anyhow!(
                "`commands` source `{}` is not a directory",
                source.display()
            ));
        }
        let out_dir = Self::commands_dir(pkg_slug)?;
        std::fs::create_dir_all(&out_dir)
            .with_context(|| format!("mkdir {}", out_dir.display()))?;

        let mut per_file_wrote = 0usize;
        let mut per_file_skipped = 0usize;
        let mut warnings: Vec<String> = Vec::new();

        let entries = std::fs::read_dir(source)
            .with_context(|| format!("readdir {}", source.display()))?;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warnings.push(format!("readdir entry: {e}"));
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name_str = match name.to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !name_str.to_lowercase().ends_with(".md") {
                continue;
            }
            let src_file = entry.path();
            let basename = &name_str[..name_str.len() - 3];
            let out_name = format!("{basename}.toml");
            let out_file = out_dir.join(&out_name);

            let md = match std::fs::read_to_string(&src_file) {
                Ok(s) => s,
                Err(e) => {
                    warnings.push(format!("{name_str}: read: {e}"));
                    continue;
                }
            };
            let toml = match md_to_gemini_command_toml(&md) {
                Ok(t) => t,
                Err(e) => {
                    warnings.push(format!("{name_str}: {e}"));
                    continue;
                }
            };

            // Idempotency: byte-equal existing file → skip without write.
            let existing = std::fs::read_to_string(&out_file).ok();
            if existing.as_deref() == Some(toml.as_str()) {
                per_file_skipped += 1;
                continue;
            }

            // Atomic write: temp file in same dir → rename.
            let tmp_name = format!(
                ".{out_name}.{}.{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let tmp = out_dir.join(tmp_name);
            if let Err(e) = std::fs::write(&tmp, &toml) {
                warnings.push(format!("{name_str}: write tmp {}: {e}", tmp.display()));
                continue;
            }
            if let Err(e) = std::fs::rename(&tmp, &out_file) {
                warnings.push(format!(
                    "{name_str}: rename {} -> {}: {e}",
                    tmp.display(),
                    out_file.display()
                ));
                // Best-effort cleanup; ignore errors.
                let _ = std::fs::remove_file(&tmp);
                continue;
            }
            per_file_wrote += 1;
        }

        let dir_ref = out_dir.display().to_string();
        let report = InstallReport {
            wrote: if per_file_wrote > 0 {
                vec![dir_ref.clone()]
            } else {
                Vec::new()
            },
            skipped: if per_file_wrote == 0 && per_file_skipped > 0 {
                vec![dir_ref]
            } else {
                Vec::new()
            },
            warnings,
        };
        Ok(report)
    }

    fn uninstall_commands_dir(pkg_slug: &str) -> Result<()> {
        let dir = Self::commands_dir(pkg_slug)?;
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => {
                log::warn!(
                    "[engine.gemini] rm -rf {} during uninstall: {e}",
                    dir.display()
                );
                Ok(())
            }
        }
    }

    /// Read `~/.gemini/settings.json`. Missing or empty → empty object.
    fn read_settings(path: &PathBuf) -> Result<Map<String, Value>> {
        match std::fs::read_to_string(path) {
            Ok(s) if s.trim().is_empty() => Ok(Map::new()),
            Ok(s) => {
                let v: Value = serde_json::from_str(&s)
                    .with_context(|| format!("parse {}", path.display()))?;
                match v {
                    Value::Object(m) => Ok(m),
                    _ => Err(anyhow!(
                        "{} is not a JSON object — refusing to overwrite",
                        path.display()
                    )),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(anyhow!("read {}: {e}", path.display())),
        }
    }

    /// Atomic write — serialize → tempfile in same dir → rename. Trailing
    /// newline matches the TS adapter's output for byte equivalence.
    fn write_settings(path: &PathBuf, root: &Map<String, Value>) -> Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("settings path has no parent"))?;
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
        let pretty = serde_json::to_string_pretty(&Value::Object(root.clone()))
            .map_err(|e| anyhow!("serialize gemini settings: {e}"))?;
        let mut pretty = pretty;
        pretty.push('\n');
        let tmp_name = format!(
            ".settings.json.{}.{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let tmp = parent.join(tmp_name);
        std::fs::write(&tmp, pretty).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, path)
            .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    /// Build the JSON value for one MCP server entry. Returns the value plus
    /// any secret-refusal warnings.
    fn build_entry(server: &McpServer) -> (Value, Vec<String>) {
        let mut warnings: Vec<String> = Vec::new();
        let re = secret_key_regex();
        for (key, value) in &server.env {
            if value.starts_with(IKENGA_SECRET_PREFIX) {
                continue;
            }
            if re.is_match(key) {
                warnings.push(format!(
                    "secret-bearing env var '{key}' must use ${{IKENGA_SECRET:<vault-key>}} indirection"
                ));
            }
        }
        // Deterministic env order via sorted keys (HashMap has no guaranteed
        // order; sorted output keeps byte equivalence across runs).
        let mut env_map = Map::new();
        let mut env_keys: Vec<&String> = server.env.keys().collect();
        env_keys.sort();
        for k in env_keys {
            if let Some(v) = server.env.get(k) {
                env_map.insert(k.clone(), Value::String(v.clone()));
            }
        }
        let mut value = json!({
            "type": "stdio",
            "command": server.command,
            "args": server.args,
            "env": Value::Object(env_map),
        });
        if server.is_long_lived() {
            if let Value::Object(ref mut m) = value {
                m.insert("disabled".to_string(), Value::Bool(true));
            }
        }
        (value, warnings)
    }
}

impl Default for GeminiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineAdapter for GeminiAdapter {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn register_mcp_server(
        &self,
        server: &McpServer,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        if server.name.is_empty() {
            return Err(anyhow!("mcp server has empty name"));
        }
        if server.command.is_empty() {
            return Err(anyhow!("mcp server '{}' has empty command", server.name));
        }

        let (value, warnings) = Self::build_entry(server);

        if !warnings.is_empty() {
            return Ok(InstallReport {
                wrote: Vec::new(),
                skipped: Vec::new(),
                warnings,
            });
        }

        let path = Self::settings_path()?;
        let mut root = Self::read_settings(&path)?;
        let key = Self::mcp_key(pkg_slug, &server.name);
        let entry_ref = format!("{}#{}", path.display(), key);

        let servers_entry = root
            .entry("mcpServers".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let servers = match servers_entry {
            Value::Object(m) => m,
            _ => {
                return Err(anyhow!(
                    "{} `mcpServers` is not an object — refusing to overwrite",
                    path.display()
                ));
            }
        };

        if let Some(existing) = servers.get(&key) {
            if existing == &value {
                return Ok(InstallReport {
                    wrote: Vec::new(),
                    skipped: vec![entry_ref],
                    warnings: Vec::new(),
                });
            }
        }

        servers.insert(key, value);
        Self::write_settings(&path, &root)?;

        Ok(InstallReport {
            wrote: vec![entry_ref],
            skipped: Vec::new(),
            warnings: Vec::new(),
        })
    }

    fn unregister_mcp_server(
        &self,
        server_name: &str,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<()> {
        let path = Self::settings_path()?;
        if !path.exists() {
            return Ok(());
        }
        let mut root = match Self::read_settings(&path) {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "[engine.gemini] read {} failed during uninstall: {e:#}",
                    path.display()
                );
                return Ok(());
            }
        };
        let key = Self::mcp_key(pkg_slug, server_name);
        let mut changed = false;
        if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
            if servers.remove(&key).is_some() {
                changed = true;
            }
        }
        if changed {
            if let Err(e) = Self::write_settings(&path, &root) {
                log::warn!(
                    "[engine.gemini] write {} failed during uninstall: {e:#}",
                    path.display()
                );
            }
        }
        Ok(())
    }

    fn install_skills(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        Self::install_asset_folder("extensions", folder, pkg_slug)
    }

    fn install_commands(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        Self::install_commands_transcoded(folder, pkg_slug)
    }

    fn install_agents(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        Self::install_asset_folder("agents", folder, pkg_slug)
    }

    fn uninstall_skills(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        Self::uninstall_asset_folder("extensions", pkg_slug)
    }

    fn uninstall_commands(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        Self::uninstall_commands_dir(pkg_slug)
    }

    fn uninstall_agents(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        Self::uninstall_asset_folder("agents", pkg_slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn server(
        name: &str,
        command: &str,
        env: &[(&str, &str)],
        lifecycle: Option<&str>,
    ) -> McpServer {
        let mut env_map = HashMap::new();
        for (k, v) in env {
            env_map.insert((*k).to_string(), (*v).to_string());
        }
        McpServer {
            name: name.to_string(),
            command: command.to_string(),
            args: vec!["serve".to_string()],
            env: env_map,
            lifecycle: lifecycle.map(str::to_string),
            restart_when_changed: Vec::new(),
            auto_restart: true,
        }
    }

    use super::super::test_util::{test_lock, HomeGuard};

    fn scratch_source() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("scratch source tempdir");
        std::fs::write(dir.path().join("SKILL.md"), "# test").unwrap();
        dir
    }

    #[test]
    fn register_mcp_writes_settings_json() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let s = server("royalti-cms", "node", &[], None);
        let report = adapter
            .register_mcp_server(&s, "com.example.foo", "com-example-foo")
            .unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.skipped.is_empty());
        assert!(report.warnings.is_empty());

        let path = GeminiAdapter::settings_path().unwrap();
        // Settings file must live under `~/.gemini/`.
        let home_str = std::env::var("HOME").unwrap();
        let expected_prefix = format!("{home_str}/.gemini/settings.json");
        assert_eq!(path.display().to_string(), expected_prefix);

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let key = "ikenga.com-example-foo.royalti-cms";
        let entry = v.get("mcpServers").unwrap().get(key).unwrap();
        assert_eq!(entry.get("type").unwrap(), "stdio");
        assert_eq!(entry.get("command").unwrap(), "node");
        assert!(entry.get("disabled").is_none());
    }

    #[test]
    fn long_lived_sets_disabled_true() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let s = server("watcher", "bun", &[], Some("long-lived"));
        adapter
            .register_mcp_server(&s, "com.example.bar", "com-example-bar")
            .unwrap();
        let raw = std::fs::read_to_string(GeminiAdapter::settings_path().unwrap()).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let entry = v
            .get("mcpServers")
            .unwrap()
            .get("ikenga.com-example-bar.watcher")
            .unwrap();
        assert_eq!(entry.get("disabled").unwrap(), &Value::Bool(true));
    }

    #[test]
    fn idempotent_reregister_skips() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let s = server("svc", "node", &[("FOO", "bar")], None);
        let r1 = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert_eq!(r1.wrote.len(), 1);
        let r2 = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert!(r2.wrote.is_empty());
        assert_eq!(r2.skipped.len(), 1);
    }

    #[test]
    fn refuses_plaintext_secret_env() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let s = server("svc", "node", &[("MY_API_KEY", "sk-plaintext")], None);
        let report = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert!(report.wrote.is_empty());
        assert!(report.skipped.is_empty());
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("MY_API_KEY"));
        assert!(!GeminiAdapter::settings_path().unwrap().exists());
    }

    #[test]
    fn install_skills_writes_symlink() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let src = scratch_source();

        let report = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();

        // Skills land under `extensions/` per ADR §1.
        let target = GeminiAdapter::asset_target("extensions", "com-test-x").unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert_eq!(report.wrote[0], target.display().to_string());
        assert!(report.warnings.is_empty());

        let link_target = std::fs::read_link(&target).unwrap();
        assert_eq!(link_target.as_path(), src.path());
    }

    #[test]
    fn install_agents_writes_symlink() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let src = scratch_source();

        let report = adapter
            .install_agents(src.path(), "com.test.x", "com-test-x")
            .unwrap();

        let target = GeminiAdapter::asset_target("agents", "com-test-x").unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert_eq!(report.wrote[0], target.display().to_string());
        let link_target = std::fs::read_link(&target).unwrap();
        assert_eq!(link_target.as_path(), src.path());
    }

    #[test]
    fn install_commands_transcodes_md_to_toml() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();

        // Build a scratch commands source with one .md file (frontmatter +
        // body) and one non-.md sibling that should be skipped.
        let src = tempfile::tempdir().expect("scratch commands src");
        let md = "---\nname: ship\ndescription: Ship a release\n---\n\nDo the thing.\n";
        std::fs::write(src.path().join("ship.md"), md).unwrap();
        std::fs::write(src.path().join("README.txt"), "ignored").unwrap();

        let report = adapter
            .install_commands(src.path(), "com.test.x", "com-test-x")
            .unwrap();

        let out_dir = GeminiAdapter::commands_dir("com-test-x").unwrap();
        // The aggregated report is ONE directory entry (slug-recovery contract).
        assert_eq!(report.wrote.len(), 1);
        assert_eq!(report.wrote[0], out_dir.display().to_string());
        assert!(report.skipped.is_empty());
        assert!(report.warnings.is_empty());

        // The .toml file must exist at <out_dir>/ship.toml.
        let out_file = out_dir.join("ship.toml");
        assert!(out_file.exists(), "ship.toml should exist at {}", out_file.display());

        // Non-.md sibling must not be transcoded.
        assert!(!out_dir.join("README.toml").exists());

        // Content sanity: text-grep for expected lines.
        let contents = std::fs::read_to_string(&out_file).unwrap();
        assert!(contents.contains("name = \"ship\""), "missing name line: {contents}");
        assert!(
            contents.contains("description = \"Ship a release\""),
            "missing description line: {contents}"
        );
        assert!(
            contents.contains("prompt = \"\"\""),
            "missing triple-quoted prompt: {contents}"
        );
        assert!(
            contents.contains("Do the thing."),
            "missing body: {contents}"
        );

        // Idempotency: a second install should report skipped, not write.
        let report2 = adapter
            .install_commands(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert!(report2.wrote.is_empty());
        assert_eq!(report2.skipped.len(), 1);
    }

    #[test]
    fn uninstall_commands_removes_dir() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();

        // Missing dir → no-op.
        adapter.uninstall_commands("com.test.x", "com-test-x").unwrap();

        // Install, then uninstall.
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("hi.md"), "---\nname: hi\n---\n\nbody\n").unwrap();
        adapter
            .install_commands(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        let out_dir = GeminiAdapter::commands_dir("com-test-x").unwrap();
        assert!(out_dir.exists());

        adapter.uninstall_commands("com.test.x", "com-test-x").unwrap();
        assert!(!out_dir.exists(), "commands dir should be gone");
    }

    #[test]
    fn unregister_mcp_removes_only_our_key() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = GeminiAdapter::new();
        let s = server("svc", "node", &[], None);
        adapter.register_mcp_server(&s, "p", "p").unwrap();

        // Plant a user-owned entry alongside ours.
        let path = GeminiAdapter::settings_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut root: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
            servers.insert(
                "user-thing".to_string(),
                json!({"type":"stdio","command":"true","args":[],"env":{}}),
            );
        }
        GeminiAdapter::write_settings(&path, &root).unwrap();

        adapter.unregister_mcp_server("svc", "p", "p").unwrap();
        let raw2 = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw2).unwrap();
        let servers = v.get("mcpServers").unwrap();
        assert!(servers.get("ikenga.p.svc").is_none());
        assert!(servers.get("user-thing").is_some());
    }
}
