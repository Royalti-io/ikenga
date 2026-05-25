//! Claude Code engine adapter — ADR-012 Track D Rust mirror of Track C's
//! TS `ClaudeCodeEngineAdapter` (`ikenga-pkgs/packages/engine/claude-code/
//! src/portability.ts`). Produces byte-equivalent on-disk results.
//!
//! What it does (MCP-only for Track D):
//!   - Writes `~/.claude/settings.json` `mcpServers.<key>` for each pkg-
//!     declared `McpServer`, where `<key> = ikenga.<pkg-slug>.<server-name>`
//!     (ADR §7). The leading `ikenga.` prefix is the namespace this adapter
//!     owns — user-authored entries without that prefix are never touched.
//!   - Lifecycle `"long-lived"` → entry written with `disabled: true`
//!     (ADR §4) so the external Claude CLI doesn't race the kernel's own
//!     `SidecarSupervisor` on the same stdio child. v1 default; revisit if
//!     UX annoys.
//!   - Secret indirection (ADR §7): if an env var's key matches
//!     `[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)` (case-insensitive) and
//!     its value doesn't begin with `${IKENGA_SECRET:`, the entry is
//!     refused — strict v1 per the TS counterpart.
//!   - Idempotent: a re-register whose computed JSON deep-equals the
//!     existing entry returns `skipped` without touching disk.
//!   - Atomic: settings load → mutate → temp-file in same dir →
//!     `std::fs::rename`. Same pattern as `mcp.rs::save_config`.
//!
//! IMPORTANT — distinct from `~/.claude.json`. The kernel's existing
//! `McpRegistry` writes to `~/.claude.json` (the file Claude Code actually
//! reads MCP from today, per `mcp.rs` comments). This adapter writes to
//! `~/.claude/settings.json`, which is the location the ADR §1 table calls
//! out for external-CLI fan-out. Two different files on purpose — see
//! ADR §1 table and `mcp.rs` line 16's "why ~/.claude.json" comment.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::symlink::symlink_dir;
use crate::pkg::engine_adapter::{EngineAdapter, InstallReport};
use crate::pkg::manifest::McpServer;

const IKENGA_SECRET_PREFIX: &str = "${IKENGA_SECRET:";

/// Cached secret-pattern regex. Same shape as the TS adapter's literal.
fn secret_key_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Case-insensitive match. The leading char class accepts A-Z only
        // (per the TS regex) but the (?i) flag makes the whole pattern
        // case-insensitive, so `foo_api_key` matches too.
        Regex::new(r"(?i)^[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)$")
            .expect("static regex compiles")
    })
}

pub struct ClaudeCodeAdapter;

impl ClaudeCodeAdapter {
    pub fn new() -> Self {
        Self
    }

    fn claude_home() -> Result<PathBuf> {
        let home = crate::platform::home_dir()
            .ok_or_else(|| anyhow!("could not resolve home directory (HOME / USERPROFILE unset)"))?;
        Ok(home.join(".claude"))
    }

    fn settings_path() -> Result<PathBuf> {
        Ok(Self::claude_home()?.join("settings.json"))
    }

    fn mcp_key(pkg_slug: &str, server_name: &str) -> String {
        format!("ikenga.{pkg_slug}.{server_name}")
    }

    /// `~/.claude/<kind>` — parent directory the per-pkg symlink lives in.
    fn assets_dir(kind: &str) -> Result<PathBuf> {
        Ok(Self::claude_home()?.join(kind))
    }

    /// `~/.claude/<kind>/<pkg-slug>` — the symlink target.
    fn asset_target(kind: &str, pkg_slug: &str) -> Result<PathBuf> {
        Ok(Self::assets_dir(kind)?.join(pkg_slug))
    }

    /// Ports `EngineAssetsRegistry::install_symlink` (engine_assets.rs:70-126)
    /// into the adapter. Shared by `install_skills/commands/agents`.
    /// Invariants preserved exactly:
    ///   - `source` must be a directory.
    ///   - target points at source already → `skipped`.
    ///   - target is a stale symlink → remove + replace, emit warning.
    ///   - target is not a symlink → error, do not clobber.
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
                        // Already pointing at us — idempotent no-op.
                        report.skipped.push(target.display().to_string());
                        return Ok(report);
                    }
                    // Stale symlink (probably from a prior install path) —
                    // safe to replace, but surface a warning so the UI can
                    // show that something was reshuffled.
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

    /// Ports `EngineAssetsRegistry::remove_target` (engine_assets.rs:128-144)
    /// into the adapter. Best-effort: missing target → no-op, non-symlink →
    /// warn and skip (we never touch user-managed state).
    fn uninstall_asset_folder(kind: &str, pkg_slug: &str) -> Result<()> {
        let target = Self::asset_target(kind, pkg_slug)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if let Err(e) = std::fs::remove_file(&target) {
                    log::warn!(
                        "[engine.claude-code] rm symlink {}: {e}",
                        target.display()
                    );
                }
            }
            Ok(_) => {
                log::warn!(
                    "[engine.claude-code] target `{}` is not a symlink — skipping (user-managed?)",
                    target.display()
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "[engine.claude-code] stat {}: {e}",
                target.display()
            ),
        }
        Ok(())
    }

    /// Read `~/.claude/settings.json`. Missing file or empty content yields
    /// an empty object so first-write works on a clean machine. Anything
    /// that's not a JSON object at the root is an error — matches the TS
    /// `readSettings` behavior.
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

    /// Atomic write — serialize → tempfile in same dir → rename. Same
    /// pattern as `mcp.rs::save_config`. Trailing newline matches the TS
    /// adapter's output for byte equivalence.
    fn write_settings(path: &PathBuf, root: &Map<String, Value>) -> Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("settings path has no parent"))?;
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
        let pretty = serde_json::to_string_pretty(&Value::Object(root.clone()))
            .map_err(|e| anyhow!("serialize claude settings: {e}"))?;
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

    /// Build the JSON value for one MCP server entry. Returns the value
    /// plus any secret-refusal warnings discovered while walking env.
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
        // env: preserve key order via a sorted Map for deterministic output.
        // serde_json::Map preserves insertion order with the `preserve_order`
        // feature; HashMap doesn't have a guaranteed order, so sort keys.
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

impl Default for ClaudeCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
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

        // Strict-refusal v1: if any env var looks like a plaintext secret,
        // refuse to write and surface the warnings. The kernel-side path
        // (~/.claude.json) is unaffected — it ran before us.
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

        // Get or create the `mcpServers` object. Non-object means a user/
        // tool put something incompatible there — bail rather than clobber.
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

        // Idempotency: deep-equal existing entry → skip without writing.
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
        // Missing file → no-op.
        if !path.exists() {
            return Ok(());
        }
        let mut root = match Self::read_settings(&path) {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "[engine.claude-code] read {} failed during uninstall: {e:#}",
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
                    "[engine.claude-code] write {} failed during uninstall: {e:#}",
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
        Self::install_asset_folder("skills", folder, pkg_slug)
    }

    fn install_commands(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        Self::install_asset_folder("commands", folder, pkg_slug)
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
        Self::uninstall_asset_folder("skills", pkg_slug)
    }

    fn uninstall_commands(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        Self::uninstall_asset_folder("commands", pkg_slug)
    }

    fn uninstall_agents(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        Self::uninstall_asset_folder("agents", pkg_slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Build a test MCP server. Lifecycle defaults to per-call.
    fn server(name: &str, command: &str, env: &[(&str, &str)], lifecycle: Option<&str>) -> McpServer {
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

    #[test]
    fn register_writes_settings_json() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server("royalti-cms", "node", &[], None);
        let report = adapter.register_mcp_server(&s, "com.example.foo", "com-example-foo").unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.skipped.is_empty());
        assert!(report.warnings.is_empty());

        let path = ClaudeCodeAdapter::settings_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let key = "ikenga.com-example-foo.royalti-cms";
        let entry = v.get("mcpServers").unwrap().get(key).unwrap();
        assert_eq!(entry.get("type").unwrap(), "stdio");
        assert_eq!(entry.get("command").unwrap(), "node");
        assert!(entry.get("disabled").is_none(), "per-call should NOT have disabled");
    }

    #[test]
    fn long_lived_sets_disabled_true() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server("watcher", "bun", &[], Some("long-lived"));
        adapter.register_mcp_server(&s, "com.example.bar", "com-example-bar").unwrap();
        let raw = std::fs::read_to_string(ClaudeCodeAdapter::settings_path().unwrap()).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let entry = v.get("mcpServers")
            .unwrap()
            .get("ikenga.com-example-bar.watcher")
            .unwrap();
        assert_eq!(entry.get("disabled").unwrap(), &Value::Bool(true));
    }

    #[test]
    fn idempotent_reregister_skips() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server("svc", "node", &[("FOO", "bar")], None);
        let r1 = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert_eq!(r1.wrote.len(), 1);
        let r2 = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert!(r2.wrote.is_empty(), "second register should not write");
        assert_eq!(r2.skipped.len(), 1, "second register should report skipped");
    }

    #[test]
    fn refuses_plaintext_secret_env() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server("svc", "node", &[("MY_API_KEY", "sk-plaintext")], None);
        let report = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert!(report.wrote.is_empty());
        assert!(report.skipped.is_empty());
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("MY_API_KEY"));
        // And no settings file should have been written.
        assert!(!ClaudeCodeAdapter::settings_path().unwrap().exists());
    }

    #[test]
    fn accepts_secret_indirection() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server(
            "svc",
            "node",
            &[("MY_API_KEY", "${IKENGA_SECRET:my_api_key}")],
            None,
        );
        let report = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn unregister_removes_only_our_key() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let s = server("svc", "node", &[], None);
        adapter.register_mcp_server(&s, "p", "p").unwrap();

        // Drop in a user-owned entry alongside ours.
        let path = ClaudeCodeAdapter::settings_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut root: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
            servers.insert(
                "user-thing".to_string(),
                json!({"type":"stdio","command":"true","args":[],"env":{}}),
            );
        }
        ClaudeCodeAdapter::write_settings(&path, &root).unwrap();

        adapter.unregister_mcp_server("svc", "p", "p").unwrap();
        let raw2 = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw2).unwrap();
        let servers = v.get("mcpServers").unwrap();
        assert!(servers.get("ikenga.p.svc").is_none(), "our key should be gone");
        assert!(servers.get("user-thing").is_some(), "user entry should remain");
    }

    #[test]
    fn unregister_missing_file_is_noop() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        adapter.unregister_mcp_server("svc", "p", "p").unwrap();
    }

    // ───── Track P: asset fan-out (install_skills/commands/agents) ─────

    /// Build a scratch source directory the adapter will symlink to.
    fn scratch_source() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("scratch source tempdir");
        // Populate with at least one file so it's clearly a real folder.
        std::fs::write(dir.path().join("SKILL.md"), "# test").unwrap();
        dir
    }

    #[test]
    fn install_skills_writes_symlink() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let src = scratch_source();

        let report = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();

        let target = ClaudeCodeAdapter::asset_target("skills", "com-test-x").unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert_eq!(report.wrote[0], target.display().to_string());
        assert!(report.skipped.is_empty());
        assert!(report.warnings.is_empty());

        // And the symlink really exists pointing at the source.
        let link_target = std::fs::read_link(&target).unwrap();
        assert_eq!(link_target.as_path(), src.path());
    }

    #[test]
    fn install_skills_is_idempotent() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let src = scratch_source();

        let r1 = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert_eq!(r1.wrote.len(), 1);

        let r2 = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert!(r2.wrote.is_empty(), "second install should not re-write");
        assert_eq!(r2.skipped.len(), 1, "second install should report skipped");
        assert!(r2.warnings.is_empty());
    }

    #[test]
    fn install_skills_refuses_to_clobber_non_symlink() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let src = scratch_source();

        // Plant a real directory where the symlink would go — user-managed
        // state we must not touch.
        let target = ClaudeCodeAdapter::asset_target("skills", "com-test-x").unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("user-file.md"), "hand-authored").unwrap();

        let err = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("is not a symlink"),
            "unexpected error: {msg}"
        );
        // The user content is still there.
        assert!(target.join("user-file.md").exists());
    }

    #[test]
    fn install_skills_replaces_stale_symlink_with_warning() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();
        let real_src = scratch_source();
        let stale_src = scratch_source();

        // Pre-create the parent + a stale symlink pointing at `stale_src`.
        let parent = ClaudeCodeAdapter::assets_dir("skills").unwrap();
        std::fs::create_dir_all(&parent).unwrap();
        let target = parent.join("com-test-x");
        #[cfg(unix)]
        std::os::unix::fs::symlink(stale_src.path(), &target).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(stale_src.path(), &target).unwrap();

        let report = adapter
            .install_skills(real_src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("replaced stale symlink"),
            "warning: {}",
            report.warnings[0]
        );

        // The symlink now points at real_src.
        let link_target = std::fs::read_link(&target).unwrap();
        assert_eq!(link_target.as_path(), real_src.path());
    }

    #[test]
    fn uninstall_skills_behaviors() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = ClaudeCodeAdapter::new();

        // Missing target — no-op.
        adapter.uninstall_skills("com.test.x", "com-test-x").unwrap();

        // Install then uninstall removes the symlink.
        let src = scratch_source();
        adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        let target = ClaudeCodeAdapter::asset_target("skills", "com-test-x").unwrap();
        assert!(std::fs::symlink_metadata(&target).is_ok());
        adapter.uninstall_skills("com.test.x", "com-test-x").unwrap();
        assert!(
            std::fs::symlink_metadata(&target)
                .err()
                .map(|e| e.kind() == std::io::ErrorKind::NotFound)
                .unwrap_or(false),
            "symlink should be gone"
        );

        // Non-symlink at target — warn and skip, do not remove.
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("user-file.md"), "user").unwrap();
        adapter.uninstall_skills("com.test.x", "com-test-x").unwrap();
        assert!(target.join("user-file.md").exists(), "user dir must survive");
    }
}
