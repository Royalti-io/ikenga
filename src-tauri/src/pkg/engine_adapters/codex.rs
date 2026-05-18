//! Codex CLI engine adapter — ADR-012 Track C Rust mirror of the TS
//! `CodexEngineAdapter` in
//! `ikenga-pkgs/packages/engine/codex/src/portability.ts`.
//!
//! On-disk layout (ADR §1):
//!   - MCP:       `~/.codex/config.toml` `[mcp_servers.ikenga.<slug>.<name>]`
//!   - Skills:    PROJECT-SCOPED `<IKENGA_CODEX_PROJECT_ROOT>/.agents/skills/<slug>/`
//!                — NOT under `~/.codex/`. If the env var is unset we WARN
//!                and skip (per the v1 brief — do NOT silently write into
//!                `~/.codex/`). The shell can wire this var up later from a
//!                project setting / `tauri::Manager::path()`.
//!   - Commands:  no first-class Codex primitive (ADR §5). Per file we
//!                check `allow_implicit_invocation` in the YAML
//!                frontmatter; true → materialize as a skill; missing/false
//!                → warn + skip per file.
//!   - Subagents: `~/.codex/agents/<slug>/<basename>.toml` — per-file
//!                MD→TOML transcode. Namespaced under the pkg slug per
//!                ADR §1 (table amended 2026-05-18 to match implementation
//!                + §7's "pkg-namespaced subdirs" rule).
//!   - AGENTS.md: skipped for v1 (out of scope).
//!
//! Env-substitution semantics (ADR §7 closed 2026-05-18):
//!   Codex's `[mcp_servers.<n>.env]` table is documented as static literal
//!   key-value pairs — no `${VAR}` or `${IKENGA_SECRET:...}` substitution.
//!   However Codex DOES support a separate `env_vars = [...]` field on the
//!   server table that forwards values from Codex's parent process env to
//!   the MCP child. We use this as the secret indirection path:
//!     - `${IKENGA_SECRET:foo}` placeholder → emit the key into `env_vars`
//!       (the user must `export FOO_API_KEY=...` before invoking the
//!       external `codex` CLI for the indirection to work). Surfaces an
//!       informational warning.
//!     - secret-shaped env key with a plaintext value → still REFUSE the
//!       entry. Plaintext secrets in a manifest are a pkg-author bug.
//!     - everything else → emit verbatim into the `.env` subtable.
//!   See: https://developers.openai.com/codex/mcp (`env_vars` schema).
//!
//! Idempotency for MCP entries is hand-rolled text-block matching, scoped
//! exactly to the `[mcp_servers.ikenga.<slug>.<name>]` shape we emit. No
//! full TOML parsing — matches the TS adapter and keeps zero deps.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use regex::Regex;

use crate::pkg::engine_adapter::{EngineAdapter, InstallReport};
use crate::pkg::engine_adapters::transcoder::md_to_codex_toml;
use crate::pkg::manifest::McpServer;

const IKENGA_SECRET_PREFIX: &str = "${IKENGA_SECRET:";

/// Env var the Codex adapter consults at every install / uninstall call to
/// resolve the project root for skills + commands materialization. Lifted
/// out of inline literals so the kernel-side updater (see
/// `set_project_root_env`) and the adapter's reader agree byte-for-byte.
pub const PROJECT_ROOT_ENV: &str = "IKENGA_CODEX_PROJECT_ROOT";

/// Kernel-side updater for the Codex project-root env var. The shell calls
/// this at boot and on every `projects:active-changed` event so the
/// adapter's per-call `project_root()` reads see the active project's
/// `root_path` without requiring the user to export the env var manually.
///
/// `Some(path)` sets the var (whether or not the path exists — the adapter
/// validates per-call). `None` clears it.
///
/// Limitation: pkgs that were already live BEFORE the project switch and
/// stay live AFTER it don't get their Codex assets re-materialized into the
/// new project's `.agents/skills/<slug>/`. Only pkgs whose `project_id`
/// changes scope across the switch go through `register` / `unregister`
/// via `kernel::reconcile_for_project`. Documented in STATUS.md.
pub fn set_project_root_env(path: Option<&str>) {
    match path {
        Some(p) if !p.is_empty() => std::env::set_var(PROJECT_ROOT_ENV, p),
        _ => std::env::remove_var(PROJECT_ROOT_ENV),
    }
}

fn secret_key_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)$")
            .expect("static regex compiles")
    })
}

pub struct CodexAdapter;

impl CodexAdapter {
    pub fn new() -> Self {
        Self
    }

    fn codex_home() -> Result<PathBuf> {
        let home = std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME not set"))?;
        Ok(PathBuf::from(home).join(".codex"))
    }

    fn config_path() -> Result<PathBuf> {
        Ok(Self::codex_home()?.join("config.toml"))
    }

    fn agents_dir() -> Result<PathBuf> {
        Ok(Self::codex_home()?.join("agents"))
    }

    fn per_pkg_agents_dir(pkg_slug: &str) -> Result<PathBuf> {
        Ok(Self::agents_dir()?.join(pkg_slug))
    }

    /// `IKENGA_CODEX_PROJECT_ROOT` opt-in escape hatch. Returns `Some(path)`
    /// only when set, absolute, and pointing at an existing directory.
    /// Otherwise `None` — callers WARN + skip rather than write into
    /// `~/.codex/` (v1 brief).
    fn project_root() -> Option<PathBuf> {
        let raw = std::env::var_os(PROJECT_ROOT_ENV)?;
        let p = PathBuf::from(raw);
        if !p.is_absolute() {
            return None;
        }
        if !p.is_dir() {
            return None;
        }
        Some(p)
    }

    fn project_skills_dir(root: &Path, pkg_slug: &str) -> PathBuf {
        root.join(".agents").join("skills").join(pkg_slug)
    }

    /// Atomic write: tmp in the same dir then rename. POSIX rename is
    /// atomic on the same fs. Mirrors `claude_code.rs::write_settings`.
    fn atomic_write(dest: &Path, content: &str) -> Result<()> {
        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("path has no parent: {}", dest.display()))?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;
        let tmp_name = format!(
            ".{}.{}.{}.tmp",
            dest.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "tmp".into()),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let tmp = parent.join(tmp_name);
        std::fs::write(&tmp, content).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, dest)
            .with_context(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;
        Ok(())
    }

    fn read_file_or_empty(path: &Path) -> Result<String> {
        match std::fs::read_to_string(path) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(anyhow!("read {}: {e}", path.display())),
        }
    }

    fn list_markdown_files(folder: &Path) -> Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(folder) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(anyhow!("readdir {}: {e}", folder.display())),
        };
        for entry in entries {
            let entry = entry.with_context(|| format!("readdir {}", folder.display()))?;
            let ft = entry.file_type()?;
            if !ft.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(".md") {
                out.push(entry.path());
            }
        }
        out.sort();
        Ok(out)
    }

    /// Emit one `[mcp_servers.ikenga.<slug>.<name>]` block. The caller has
    /// already partitioned env into the literal subtable + the env_vars
    /// allowlist. Returns the block plus the table-header string for
    /// idempotency search.
    fn emit_mcp_block(
        pkg_slug: &str,
        server: &McpServer,
        env_table: &[(&String, &String)],
        env_vars_allowlist: &[String],
    ) -> (String, String) {
        let table_name = format!("mcp_servers.ikenga.{pkg_slug}.{}", server.name);
        let table_header = format!("[{table_name}]");
        let mut out = String::new();
        out.push_str(&table_header);
        out.push('\n');
        out.push_str(&format!("command = {}\n", quote_toml_string(&server.command)));
        let args_str = server
            .args
            .iter()
            .map(|a| quote_toml_string(a))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("args = [{args_str}]\n"));
        if !env_vars_allowlist.is_empty() {
            let mut sorted: Vec<&String> = env_vars_allowlist.iter().collect();
            sorted.sort();
            let joined = sorted
                .iter()
                .map(|s| quote_toml_string(s))
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("env_vars = [{joined}]\n"));
        }
        if server.is_long_lived() {
            // ADR §4: don't let external Codex CLI race the kernel's own
            // SidecarSupervisor on the same stdio child.
            out.push_str("disabled = true\n");
        }
        if !env_table.is_empty() {
            out.push('\n');
            out.push_str(&format!("[{table_name}.env]\n"));
            let mut sorted: Vec<&(&String, &String)> = env_table.iter().collect();
            sorted.sort_by_key(|(k, _)| k.as_str());
            for (k, v) in sorted {
                out.push_str(&format!("{k} = {}\n", quote_toml_string(v)));
            }
        }
        (out, table_header)
    }

    /// Partition a manifest env block into the literal `.env` subtable
    /// entries and the `env_vars` allowlist (per ADR §7 closure, 2026-05-18).
    /// Returns `(env_table, env_vars_allowlist, refuse_warnings, info_warnings)`.
    /// A non-empty `refuse_warnings` vec means the caller must skip the
    /// write entirely — plaintext secrets in a manifest are a pkg-author
    /// bug we refuse to materialize.
    #[allow(clippy::type_complexity)]
    fn partition_env<'a>(
        server: &'a McpServer,
    ) -> (
        Vec<(&'a String, &'a String)>,
        Vec<String>,
        Vec<String>,
        Vec<String>,
    ) {
        let re = secret_key_regex();
        let mut env_table: Vec<(&String, &String)> = Vec::new();
        let mut env_vars_allowlist: Vec<String> = Vec::new();
        let mut refuse_warnings: Vec<String> = Vec::new();
        let mut info_warnings: Vec<String> = Vec::new();
        for (key, value) in &server.env {
            if value.starts_with(IKENGA_SECRET_PREFIX) {
                env_vars_allowlist.push(key.clone());
                info_warnings.push(format!(
                    "Codex MCP env `{key}` translated to `env_vars` allowlist — \
                     export {key}=... in your shell before invoking the external `codex` CLI"
                ));
            } else if re.is_match(key) {
                refuse_warnings.push(format!(
                    "secret-bearing env var '{key}' must use ${{IKENGA_SECRET:<vault-key>}} \
                     indirection — plaintext refused"
                ));
            } else {
                env_table.push((key, value));
            }
        }
        (env_table, env_vars_allowlist, refuse_warnings, info_warnings)
    }

    /// Find the line-range of an existing `<table_header>` block in `toml`,
    /// extending through any `<table_header>.env` subtable, bounded by EOF
    /// or the next top-level `[..]` header that's not a subtable. Returns
    /// `(start_byte, end_byte)` or None.
    fn find_block_range(toml: &str, table_header: &str) -> Option<(usize, usize)> {
        let base_name = &table_header[1..table_header.len() - 1];
        let sub_prefix = format!("[{base_name}.");
        let lines: Vec<&str> = toml.split('\n').collect();
        let mut start_line: Option<usize> = None;
        for (i, l) in lines.iter().enumerate() {
            if *l == table_header {
                start_line = Some(i);
                break;
            }
        }
        let start_line = start_line?;
        let mut end_line = lines.len();
        for (i, l) in lines.iter().enumerate().skip(start_line + 1) {
            let t = l.trim_start();
            if t.starts_with('[') {
                if t.starts_with(&sub_prefix) {
                    continue;
                }
                end_line = i;
                break;
            }
        }
        // Translate to byte indices.
        let mut start = 0usize;
        for l in lines.iter().take(start_line) {
            start += l.len() + 1;
        }
        let mut end = start;
        for l in lines.iter().take(end_line).skip(start_line) {
            end += l.len() + 1;
        }
        if end > toml.len() {
            end = toml.len();
        }
        Some((start, end))
    }

/// Best-effort uninstall: remove a per-slug path that may be either a
    /// symlink (skills case) or a real dir (commands-as-skills case). User
    /// data is never touched outside the per-slug namespace.
    fn remove_symlink_or_dir(target: &Path) -> Result<()> {
        match std::fs::symlink_metadata(target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    if let Err(e) = std::fs::remove_file(target) {
                        log::warn!(
                            "[engine.codex] rm symlink {}: {e}",
                            target.display()
                        );
                    }
                } else if let Err(e) = std::fs::remove_dir_all(target) {
                    log::warn!(
                        "[engine.codex] rm dir {}: {e}",
                        target.display()
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[engine.codex] stat {}: {e}", target.display()),
        }
        Ok(())
    }
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// Minimal TOML basic-string quoting. We only emit our own values (command,
/// args, env values), so the input is well-formed UTF-8 from the manifest.
/// Mirrors `JSON.stringify` on the TS side closely enough to be
/// byte-comparable for idempotency.
fn quote_toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl EngineAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
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

        let (env_table, env_vars_allowlist, refuse_warnings, info_warnings) =
            Self::partition_env(server);
        if !refuse_warnings.is_empty() {
            return Ok(InstallReport {
                wrote: Vec::new(),
                skipped: Vec::new(),
                warnings: refuse_warnings,
            });
        }

        let (block, table_header) =
            Self::emit_mcp_block(pkg_slug, server, &env_table, &env_vars_allowlist);
        let dest = Self::config_path()?;
        let existing = Self::read_file_or_empty(&dest)?;
        let entry_ref = format!("{}#{}", dest.display(), &table_header[1..table_header.len() - 1]);

        if let Some((start, end)) = Self::find_block_range(&existing, &table_header) {
            let current = &existing[start..end];
            // Normalize trailing whitespace for byte-stable idempotency.
            let cur_trim = current.trim_end_matches(|c: char| c.is_whitespace());
            let new_trim = block.trim_end_matches(|c: char| c.is_whitespace());
            if cur_trim == new_trim {
                return Ok(InstallReport {
                    wrote: Vec::new(),
                    skipped: vec![entry_ref],
                    warnings: info_warnings,
                });
            }
            let mut merged = String::with_capacity(existing.len() + block.len());
            merged.push_str(&existing[..start]);
            merged.push_str(&block);
            let after = &existing[end..];
            if !after.is_empty() && !after.starts_with('\n') {
                merged.push('\n');
            }
            merged.push_str(after);
            Self::atomic_write(&dest, &merged)?;
            return Ok(InstallReport {
                wrote: vec![entry_ref],
                skipped: Vec::new(),
                warnings: info_warnings,
            });
        }

        // Append. Ensure separation from existing content.
        let mut merged = existing.clone();
        if !merged.is_empty() && !merged.ends_with("\n\n") {
            if merged.ends_with('\n') {
                merged.push('\n');
            } else {
                merged.push_str("\n\n");
            }
        }
        merged.push_str(&block);
        Self::atomic_write(&dest, &merged)?;
        Ok(InstallReport {
            wrote: vec![entry_ref],
            skipped: Vec::new(),
            warnings: info_warnings,
        })
    }

    fn unregister_mcp_server(
        &self,
        server_name: &str,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<()> {
        let dest = Self::config_path()?;
        if !dest.exists() {
            return Ok(());
        }
        let existing = match Self::read_file_or_empty(&dest) {
            Ok(s) => s,
            Err(e) => {
                log::warn!(
                    "[engine.codex] read {} during uninstall: {e:#}",
                    dest.display()
                );
                return Ok(());
            }
        };
        let table_header = format!("[mcp_servers.ikenga.{pkg_slug}.{server_name}]");
        let Some((start, end)) = Self::find_block_range(&existing, &table_header) else {
            return Ok(());
        };
        let mut merged = String::with_capacity(existing.len());
        merged.push_str(&existing[..start]);
        merged.push_str(&existing[end..]);
        // Collapse triple-blank runs from joining.
        while merged.contains("\n\n\n") {
            merged = merged.replace("\n\n\n", "\n\n");
        }
        if let Err(e) = Self::atomic_write(&dest, &merged) {
            log::warn!(
                "[engine.codex] write {} during uninstall: {e:#}",
                dest.display()
            );
        }
        Ok(())
    }

    fn install_skills(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        let Some(root) = Self::project_root() else {
            return Ok(InstallReport {
                wrote: Vec::new(),
                skipped: Vec::new(),
                warnings: vec![format!(
                    "IKENGA_CODEX_PROJECT_ROOT not set — Codex skills require a project root; skipping skill folder for pkg-slug `{pkg_slug}`"
                )],
            });
        };
        if !folder.is_dir() {
            return Err(anyhow!(
                "`skills` source `{}` is not a directory",
                folder.display()
            ));
        }
        let target = Self::project_skills_dir(&root, pkg_slug);
        let parent = target.parent().unwrap_or(&root).to_path_buf();
        std::fs::create_dir_all(&parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;

        let mut report = InstallReport::default();
        let source = folder.to_path_buf();
        match std::fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let current = std::fs::read_link(&target).ok();
                    if current.as_deref() == Some(source.as_path()) {
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
        super::symlink::symlink_dir(&source, &target)
            .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))?;
        report.wrote.push(target.display().to_string());
        Ok(report)
    }

    fn install_commands(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        let files = Self::list_markdown_files(folder)?;

        let Some(root) = Self::project_root() else {
            let warnings = files
                .iter()
                .map(|f| {
                    format!(
                        "command file {} skipped — IKENGA_CODEX_PROJECT_ROOT not set (Codex has no first-class commands primitive)",
                        f.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    )
                })
                .collect();
            return Ok(InstallReport {
                wrote: Vec::new(),
                skipped: Vec::new(),
                warnings,
            });
        };

        let skills_root = Self::project_skills_dir(&root, pkg_slug);
        let mut wrote = Vec::new();
        let mut skipped = Vec::new();
        let mut warnings = Vec::new();

        for file in files {
            let md = std::fs::read_to_string(&file)
                .with_context(|| format!("read {}", file.display()))?;
            let implicit = frontmatter_has_implicit_invocation(&md);
            let base = file
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let basename = file
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !implicit {
                warnings.push(format!(
                    "command {basename} skipped — Codex has no first-class commands primitive; set `allow_implicit_invocation: true` in frontmatter to convert to a skill"
                ));
                continue;
            }
            let dest = skills_root.join(&base).join("SKILL.md");
            let on_disk = std::fs::read_to_string(&dest).ok();
            if on_disk.as_deref() == Some(md.as_str()) {
                skipped.push(dest.display().to_string());
                continue;
            }
            Self::atomic_write(&dest, &md)?;
            wrote.push(dest.display().to_string());
        }

        Ok(InstallReport {
            wrote,
            skipped,
            warnings,
        })
    }

    fn install_agents(
        &self,
        folder: &Path,
        _pkg_id: &str,
        pkg_slug: &str,
    ) -> Result<InstallReport> {
        let files = Self::list_markdown_files(folder)?;
        let per_pkg = Self::per_pkg_agents_dir(pkg_slug)?;

        let mut warnings = Vec::new();
        let mut any_write = false;
        let mut any_skip = false;

        for file in files {
            let md = std::fs::read_to_string(&file)
                .with_context(|| format!("read {}", file.display()))?;
            let toml = match md_to_codex_toml(&md) {
                Ok(t) => t,
                Err(e) => {
                    let name = file
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    warnings.push(format!("transcode {name}: {e}"));
                    continue;
                }
            };
            let base = file
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let dest = per_pkg.join(format!("{base}.toml"));
            let existing = std::fs::read_to_string(&dest).ok();
            if existing.as_deref() == Some(toml.as_str()) {
                any_skip = true;
                continue;
            }
            Self::atomic_write(&dest, &toml)?;
            any_write = true;
        }

        let mut wrote = Vec::new();
        let mut skipped = Vec::new();
        if any_write {
            wrote.push(per_pkg.display().to_string());
        } else if any_skip {
            skipped.push(per_pkg.display().to_string());
        }

        Ok(InstallReport {
            wrote,
            skipped,
            warnings,
        })
    }

    fn uninstall_skills(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        let Some(root) = Self::project_root() else {
            return Ok(());
        };
        let target = Self::project_skills_dir(&root, pkg_slug);
        Self::remove_symlink_or_dir(&target)
    }

    fn uninstall_commands(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        // Commands materialize as skills under the same per-slug dir.
        let Some(root) = Self::project_root() else {
            return Ok(());
        };
        let target = Self::project_skills_dir(&root, pkg_slug);
        Self::remove_symlink_or_dir(&target)
    }

    fn uninstall_agents(&self, _pkg_id: &str, pkg_slug: &str) -> Result<()> {
        let target = Self::per_pkg_agents_dir(pkg_slug)?;
        if let Err(e) = std::fs::remove_dir_all(&target) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[engine.codex] rm {}: {e}", target.display());
            }
        }
        Ok(())
    }
}

/// Tiny one-shot YAML frontmatter probe — returns true iff the YAML block
/// has `allow_implicit_invocation: true`. Anything else (missing, `false`,
/// malformed) is false.
fn frontmatter_has_implicit_invocation(md: &str) -> bool {
    let mut lines = md.split('\n');
    let Some(first) = lines.next() else {
        return false;
    };
    if first.trim() != "---" {
        return false;
    }
    for line in lines {
        let t = line.trim();
        if t == "---" {
            return false;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim();
        let val = line[colon + 1..].trim();
        if key == "allow_implicit_invocation" {
            return val == "true";
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn server(name: &str, command: &str, env: &[(&str, &str)]) -> McpServer {
        let mut env_map = HashMap::new();
        for (k, v) in env {
            env_map.insert((*k).to_string(), (*v).to_string());
        }
        McpServer {
            name: name.to_string(),
            command: command.to_string(),
            args: vec!["serve".to_string()],
            env: env_map,
            lifecycle: None,
            restart_when_changed: Vec::new(),
            auto_restart: true,
        }
    }

    use super::super::test_util::{test_lock, HomeGuard};

    #[test]
    fn register_mcp_writes_config_toml() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let s = server("royalti-cms", "bun", &[]);
        let report = adapter
            .register_mcp_server(&s, "com.example.foo", "com-example-foo")
            .unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.skipped.is_empty());
        assert!(report.warnings.is_empty());

        let path = CodexAdapter::config_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("[mcp_servers.ikenga.com-example-foo.royalti-cms]"));
        assert!(raw.contains("command = \"bun\""));
        assert!(raw.contains("args = [\"serve\"]"));

        // Idempotent.
        let r2 = adapter
            .register_mcp_server(&s, "com.example.foo", "com-example-foo")
            .unwrap();
        assert!(r2.wrote.is_empty(), "second register should not write");
        assert_eq!(r2.skipped.len(), 1, "second register should report skipped");
    }

    #[test]
    fn register_mcp_translates_secret_placeholder_to_env_vars() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let s = server(
            "exa",
            "bun",
            &[("EXA_API_KEY", "${IKENGA_SECRET:exa_api_key}")],
        );
        let report = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert_eq!(report.wrote.len(), 1, "entry should be written");
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("env_vars` allowlist") && w.contains("EXA_API_KEY")),
            "expected env_vars informational warning, got {:?}",
            report.warnings
        );

        // On disk: `env_vars = ["EXA_API_KEY"]` line, no [.env] subtable
        // (every env entry was a secret placeholder → all routed to allowlist).
        let raw = std::fs::read_to_string(CodexAdapter::config_path().unwrap()).unwrap();
        assert!(raw.contains("env_vars = [\"EXA_API_KEY\"]"));
        assert!(!raw.contains("[mcp_servers.ikenga.p.exa.env]"));
    }

    #[test]
    fn register_mcp_mixed_env_emits_both_blocks() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let s = server(
            "svc",
            "node",
            &[
                ("FOO_API_KEY", "${IKENGA_SECRET:foo}"),
                ("PLAIN_DEBUG", "1"),
            ],
        );
        let report = adapter.register_mcp_server(&s, "p", "svc").unwrap();
        assert_eq!(report.wrote.len(), 1);
        let raw = std::fs::read_to_string(CodexAdapter::config_path().unwrap()).unwrap();
        assert!(raw.contains("env_vars = [\"FOO_API_KEY\"]"));
        assert!(raw.contains("[mcp_servers.ikenga.svc.svc.env]"));
        assert!(raw.contains("PLAIN_DEBUG = \"1\""));
        assert!(
            !raw.contains("FOO_API_KEY ="),
            "secret-placeholder must NOT appear in .env subtable"
        );
    }

    #[test]
    fn register_mcp_refuses_plaintext_secret() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let s = server("svc", "bun", &[("MY_API_KEY", "sk-plain")]);
        let report = adapter.register_mcp_server(&s, "p", "p").unwrap();
        assert!(report.wrote.is_empty());
        assert!(!report.warnings.is_empty());
        assert!(report.warnings[0].contains("MY_API_KEY"));
    }

    #[test]
    fn install_agents_transcodes_md_to_toml() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let src = tempfile::tempdir().unwrap();
        let md = "---\nname: planner\ndescription: Builds plans\nmodel: o4-mini\n---\n\nYou are a planner.\n";
        std::fs::write(src.path().join("planner.md"), md).unwrap();

        let report = adapter
            .install_agents(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.warnings.is_empty());

        let per_pkg = CodexAdapter::per_pkg_agents_dir("com-test-x").unwrap();
        let toml = std::fs::read_to_string(per_pkg.join("planner.toml")).unwrap();
        assert!(toml.contains("name = \"planner\""));
        assert!(toml.contains("model = \"o4-mini\""));
        assert!(
            toml.contains("system_prompt = \"\"\"") || toml.contains("system_prompt = "),
            "expected system_prompt in toml: {toml}"
        );

        // Idempotent.
        let r2 = adapter
            .install_agents(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert!(r2.wrote.is_empty(), "second install should not re-write");
        assert_eq!(r2.skipped.len(), 1);
    }

    #[test]
    fn install_skills_skips_when_project_root_unset() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        // Ensure env var is unset for this test.
        std::env::remove_var("IKENGA_CODEX_PROJECT_ROOT");
        let adapter = CodexAdapter::new();
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("SKILL.md"), "# test").unwrap();

        let report = adapter
            .install_skills(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert!(report.wrote.is_empty());
        assert!(report.skipped.is_empty());
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("IKENGA_CODEX_PROJECT_ROOT not set"),
            "warning: {}",
            report.warnings[0]
        );
    }

    #[test]
    fn install_commands_with_implicit_invocation_writes_as_skill() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let project = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("IKENGA_CODEX_PROJECT_ROOT");
        std::env::set_var("IKENGA_CODEX_PROJECT_ROOT", project.path());

        let src = tempfile::tempdir().unwrap();
        let md = "---\nname: blog\ndescription: do thing\nallow_implicit_invocation: true\n---\n\nbody\n";
        std::fs::write(src.path().join("blog.md"), md).unwrap();

        let adapter = CodexAdapter::new();
        let report = adapter
            .install_commands(src.path(), "com.test.x", "com-test-x")
            .unwrap();
        assert_eq!(report.wrote.len(), 1);
        assert!(report.warnings.is_empty());

        let dest = project
            .path()
            .join(".agents")
            .join("skills")
            .join("com-test-x")
            .join("blog")
            .join("SKILL.md");
        let on_disk = std::fs::read_to_string(dest).unwrap();
        assert_eq!(on_disk, md);

        // Restore env var.
        match prev {
            Some(v) => std::env::set_var("IKENGA_CODEX_PROJECT_ROOT", v),
            None => std::env::remove_var("IKENGA_CODEX_PROJECT_ROOT"),
        }
    }

    #[test]
    fn set_project_root_env_round_trips() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let prev = std::env::var_os(PROJECT_ROOT_ENV);
        std::env::remove_var(PROJECT_ROOT_ENV);

        // None / empty → unset.
        set_project_root_env(None);
        assert!(std::env::var_os(PROJECT_ROOT_ENV).is_none());
        set_project_root_env(Some(""));
        assert!(std::env::var_os(PROJECT_ROOT_ENV).is_none());

        // Some(path) → set.
        set_project_root_env(Some("/tmp/foo"));
        assert_eq!(
            std::env::var(PROJECT_ROOT_ENV).unwrap(),
            "/tmp/foo".to_string()
        );

        // Re-set with None clears it.
        set_project_root_env(None);
        assert!(std::env::var_os(PROJECT_ROOT_ENV).is_none());

        match prev {
            Some(v) => std::env::set_var(PROJECT_ROOT_ENV, v),
            None => std::env::remove_var(PROJECT_ROOT_ENV),
        }
    }

    #[test]
    fn unregister_removes_only_our_table() {
        let _g = test_lock();
        let _h = HomeGuard::new();
        let adapter = CodexAdapter::new();
        let path = CodexAdapter::config_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "[user]\nmode = \"default\"\n\n[mcp_servers.user-thing]\ncommand = \"echo\"\n",
        )
        .unwrap();

        let s = server("mine", "bun", &[]);
        adapter.register_mcp_server(&s, "p", "p").unwrap();
        let after_register = std::fs::read_to_string(&path).unwrap();
        assert!(after_register.contains("[mcp_servers.ikenga.p.mine]"));

        adapter.unregister_mcp_server("mine", "p", "p").unwrap();
        let final_content = std::fs::read_to_string(&path).unwrap();
        assert!(final_content.contains("[user]"));
        assert!(final_content.contains("[mcp_servers.user-thing]"));
        assert!(!final_content.contains("[mcp_servers.ikenga.p.mine]"));
    }
}
