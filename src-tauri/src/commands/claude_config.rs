//! `/claude` config browser backend.
//!
//! Scans the on-disk Claude Code config (agents/skills/commands/hooks) across
//! a user-managed list of project roots plus the personal `~/.claude` dir.
//! There is no `claude` CLI subcommand to list these, so we read the FS
//! directly. Read-only — never writes.
//!
//! Paths scanned for each project root `<P>`:
//!   - `<P>/.claude/agents/*.md`           — agent definitions
//!   - `<P>/.claude/skills/<name>/SKILL.md`
//!   - `<P>/.claude/commands/*.md`         — slash commands
//!   - `<P>/.claude/settings.local.json`   — hook config (one of the keys)
//!
//! Personal:
//!   - `~/.claude/agents/*.md`
//!   - `~/.claude/skills/<name>/SKILL.md`
//!   - `~/.claude/commands/*.md`
//!   - `~/.claude/settings.json`
//!
//! These paths are not in the global Tauri allowlist (`is_allowed`) but the
//! commands here are read-only and constrained to the structure above, so
//! they call `std::fs` directly with input paths normalized through
//! `shellexpand`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::fs_watch::FsWatchManager;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Personal,
}

#[derive(Debug, Serialize)]
pub struct AgentEntry {
    pub name: String,
    pub scope: Scope,
    /// Project root this entry belongs to (`null` for personal).
    #[serde(rename = "projectRoot")]
    pub project_root: Option<String>,
    pub path: String,
    /// File mtime (epoch ms).
    #[serde(rename = "modifiedMs")]
    pub modified_ms: i64,
    pub description: Option<String>,
    pub model: Option<String>,
    /// All frontmatter rendered as JSON for the detail-view grid.
    pub frontmatter: serde_json::Value,
    /// Markdown body (everything after the closing `---`).
    pub body: String,
    /// True if a project entry of the same name overrides this personal one.
    #[serde(rename = "overriddenBy")]
    pub overridden_by: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub scope: Scope,
    #[serde(rename = "projectRoot")]
    pub project_root: Option<String>,
    pub path: String,
    /// Skill dir (parent of SKILL.md). Used to enumerate supporting files.
    #[serde(rename = "dirPath")]
    pub dir_path: String,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: i64,
    pub description: Option<String>,
    pub frontmatter: serde_json::Value,
    pub body: String,
    /// Sibling files in the skill dir (excluding SKILL.md).
    #[serde(rename = "supportingFiles")]
    pub supporting_files: Vec<SupportingFile>,
    #[serde(rename = "overriddenBy")]
    pub overridden_by: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SupportingFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct CommandEntry {
    pub name: String,
    pub scope: Scope,
    #[serde(rename = "projectRoot")]
    pub project_root: Option<String>,
    pub path: String,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: i64,
    pub description: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "argumentHint")]
    pub argument_hint: Option<String>,
    pub frontmatter: serde_json::Value,
    pub body: String,
    #[serde(rename = "overriddenBy")]
    pub overridden_by: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpEntry {
    /// Server name (key under `mcpServers`).
    pub name: String,
    pub scope: Scope,
    #[serde(rename = "projectRoot")]
    pub project_root: Option<String>,
    /// Source file (e.g. `.claude/mcp.json`).
    pub path: String,
    /// Transport: `stdio`, `http`, or `sse`.
    pub transport: String,
    /// stdio: program; http/sse: null.
    pub command: Option<String>,
    /// stdio args.
    pub args: Vec<String>,
    /// Env-var keys declared (values stripped — they may be secrets).
    #[serde(rename = "envKeys")]
    pub env_keys: Vec<String>,
    /// http/sse: server URL.
    pub url: Option<String>,
    /// http/sse: header names declared.
    #[serde(rename = "headerKeys")]
    pub header_keys: Vec<String>,
    /// Raw entry JSON for the detail preview.
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct HookEntry {
    /// Hook event name: `SessionStart`, `Stop`, `PreCompact`, `PreToolUse`, ...
    pub event: String,
    /// Hook type: `command`, `prompt`, etc.
    #[serde(rename = "type")]
    pub kind: String,
    /// Display name — basename of the command path or the inline matcher.
    pub name: String,
    pub scope: Scope,
    #[serde(rename = "projectRoot")]
    pub project_root: Option<String>,
    /// Path to the settings file the hook is declared in.
    #[serde(rename = "settingsPath")]
    pub settings_path: String,
    /// Resolved absolute path to the script (only when `kind == "command"`).
    #[serde(rename = "commandPath")]
    pub command_path: Option<String>,
    /// Raw command string as written in settings.json (unresolved).
    #[serde(rename = "commandRaw")]
    pub command_raw: Option<String>,
    /// Raw entry as JSON for the JSON config preview.
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ClaudeConfig {
    pub agents: Vec<AgentEntry>,
    pub skills: Vec<SkillEntry>,
    pub commands: Vec<CommandEntry>,
    pub hooks: Vec<HookEntry>,
    pub mcps: Vec<McpEntry>,
    /// Scan errors per root (path → message). Surfaced in the UI footer.
    pub errors: Vec<ScanError>,
}

#[derive(Debug, Serialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

// ─── Public commands ────────────────────────────────────────────────────────

/// Scan all project roots + personal dir, return a single config tree.
#[tauri::command]
pub async fn claude_config_load(
    #[allow(non_snake_case)] projectRoots: Vec<String>,
) -> Result<ClaudeConfig, String> {
    let project_roots = projectRoots;
    tokio::task::spawn_blocking(move || scan_all(project_roots))
        .await
        .map_err(|e| format!("join failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Watch every `.claude/` dir in the supplied roots + the personal `~/.claude/`.
/// One watcher per dir, all emitting on the same event channel
/// `claude-config:changed`. Returns the list of watcher ids so the frontend
/// can release them on unmount via `claude_config_unwatch`.
#[tauri::command]
pub async fn claude_config_watch(
    app: AppHandle,
    manager: State<'_, Arc<FsWatchManager>>,
    #[allow(non_snake_case)] projectRoots: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let mut targets: Vec<PathBuf> = Vec::new();
    for root in &projectRoots {
        if let Ok(p) = expand(root) {
            let claude_dir = p.join(".claude");
            if claude_dir.is_dir() {
                targets.push(claude_dir);
            }
        }
    }
    if let Some(home) = home_dir() {
        let personal = home.join(".claude");
        if personal.is_dir() {
            targets.push(personal);
        }
    }
    for t in targets {
        match manager.watch(app.clone(), &t) {
            Ok(id) => ids.push(id),
            Err(e) => log::warn!("claude_config_watch failed for {}: {e}", t.display()),
        }
    }
    Ok(ids)
}

#[tauri::command]
pub async fn claude_config_unwatch(
    manager: State<'_, Arc<FsWatchManager>>,
    #[allow(non_snake_case)] watcherIds: Vec<String>,
) -> Result<(), String> {
    for id in watcherIds {
        let _ = manager.unwatch(&id);
    }
    Ok(())
}

/// Read an arbitrary file under a `.claude/` dir (e.g. a hook script body or a
/// skill supporting file). Restricted to paths whose canonical form sits under
/// either a `.claude/` segment or `~/.claude/`. Read-only.
#[tauri::command]
pub async fn claude_config_read_file(path: String) -> Result<String, String> {
    let resolved = expand(&path).map_err(|e| e.to_string())?;
    if !is_under_claude_dir(&resolved) {
        return Err(format!(
            "path not under a .claude/ dir: {}",
            resolved.display()
        ));
    }
    tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("read failed: {e}"))
}

// ─── Scanning ──────────────────────────────────────────────────────────────

fn scan_all(project_roots: Vec<String>) -> Result<ClaudeConfig> {
    let mut agents: Vec<AgentEntry> = Vec::new();
    let mut skills: Vec<SkillEntry> = Vec::new();
    let mut commands: Vec<CommandEntry> = Vec::new();
    let mut hooks: Vec<HookEntry> = Vec::new();
    let mut mcps: Vec<McpEntry> = Vec::new();
    let mut errors: Vec<ScanError> = Vec::new();

    // Project scope.
    for raw in &project_roots {
        let root = match expand(raw) {
            Ok(p) => p,
            Err(e) => {
                errors.push(ScanError {
                    path: raw.clone(),
                    message: format!("expand: {e}"),
                });
                continue;
            }
        };
        let claude = root.join(".claude");
        if !claude.is_dir() {
            // Silent skip — many project roots may not have a .claude/ dir.
            continue;
        }
        scan_project(
            &root,
            &claude,
            &mut agents,
            &mut skills,
            &mut commands,
            &mut hooks,
            &mut mcps,
            &mut errors,
        );
    }

    // Personal scope.
    if let Some(home) = home_dir() {
        let personal = home.join(".claude");
        if personal.is_dir() {
            scan_personal(
                &personal,
                &mut agents,
                &mut skills,
                &mut commands,
                &mut hooks,
                &mut mcps,
                &mut errors,
            );
        }
    }

    // Override resolution: any project entry with the same name wins; mark the
    // personal twin with `overridden_by`.
    mark_overrides_agents(&mut agents);
    mark_overrides_skills(&mut skills);
    mark_overrides_commands(&mut commands);

    // Sort each list by name asc.
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    hooks.sort_by(|a, b| a.event.cmp(&b.event).then_with(|| a.name.cmp(&b.name)));
    mcps.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ClaudeConfig {
        agents,
        skills,
        commands,
        hooks,
        mcps,
        errors,
    })
}

fn scan_project(
    root: &Path,
    claude: &Path,
    agents: &mut Vec<AgentEntry>,
    skills: &mut Vec<SkillEntry>,
    commands: &mut Vec<CommandEntry>,
    hooks: &mut Vec<HookEntry>,
    mcps: &mut Vec<McpEntry>,
    errors: &mut Vec<ScanError>,
) {
    let root_str = root.to_string_lossy().to_string();
    scan_md_dir(
        &claude.join("agents"),
        Scope::Project,
        Some(&root_str),
        |entry| agents.push(agent_from_md(entry)),
        errors,
    );
    scan_skills_dir(
        &claude.join("skills"),
        Scope::Project,
        Some(&root_str),
        skills,
        errors,
    );
    scan_md_dir(
        &claude.join("commands"),
        Scope::Project,
        Some(&root_str),
        |entry| commands.push(command_from_md(entry)),
        errors,
    );

    // Hooks + inline mcpServers: read both settings.local.json and settings.json.
    for f in ["settings.local.json", "settings.json"] {
        let p = claude.join(f);
        if p.is_file() {
            match parse_hooks_file(&p, Scope::Project, Some(&root_str)) {
                Ok(mut h) => hooks.append(&mut h),
                Err(e) => errors.push(ScanError {
                    path: p.to_string_lossy().to_string(),
                    message: format!("hooks parse: {e}"),
                }),
            }
            match parse_mcp_from_settings(&p, Scope::Project, Some(&root_str)) {
                Ok(mut m) => mcps.append(&mut m),
                Err(e) => errors.push(ScanError {
                    path: p.to_string_lossy().to_string(),
                    message: format!("mcp(settings) parse: {e}"),
                }),
            }
        }
    }

    // Standalone .claude/mcp.json (canonical project MCP file).
    let mcp_json = claude.join("mcp.json");
    if mcp_json.is_file() {
        match parse_mcp_file(&mcp_json, Scope::Project, Some(&root_str)) {
            Ok(mut m) => mcps.append(&mut m),
            Err(e) => errors.push(ScanError {
                path: mcp_json.to_string_lossy().to_string(),
                message: format!("mcp parse: {e}"),
            }),
        }
    }
}

fn scan_personal(
    personal: &Path,
    agents: &mut Vec<AgentEntry>,
    skills: &mut Vec<SkillEntry>,
    commands: &mut Vec<CommandEntry>,
    hooks: &mut Vec<HookEntry>,
    mcps: &mut Vec<McpEntry>,
    errors: &mut Vec<ScanError>,
) {
    scan_md_dir(
        &personal.join("agents"),
        Scope::Personal,
        None,
        |entry| agents.push(agent_from_md(entry)),
        errors,
    );
    scan_skills_dir(
        &personal.join("skills"),
        Scope::Personal,
        None,
        skills,
        errors,
    );
    scan_md_dir(
        &personal.join("commands"),
        Scope::Personal,
        None,
        |entry| commands.push(command_from_md(entry)),
        errors,
    );
    let p = personal.join("settings.json");
    if p.is_file() {
        match parse_hooks_file(&p, Scope::Personal, None) {
            Ok(mut h) => hooks.append(&mut h),
            Err(e) => errors.push(ScanError {
                path: p.to_string_lossy().to_string(),
                message: format!("hooks parse: {e}"),
            }),
        }
        match parse_mcp_from_settings(&p, Scope::Personal, None) {
            Ok(mut m) => mcps.append(&mut m),
            Err(e) => errors.push(ScanError {
                path: p.to_string_lossy().to_string(),
                message: format!("mcp(settings) parse: {e}"),
            }),
        }
    }
    // Personal-level top-level mcp.json or ~/.claude.json `mcpServers`.
    let mcp_json = personal.join("mcp.json");
    if mcp_json.is_file() {
        match parse_mcp_file(&mcp_json, Scope::Personal, None) {
            Ok(mut m) => mcps.append(&mut m),
            Err(e) => errors.push(ScanError {
                path: mcp_json.to_string_lossy().to_string(),
                message: format!("mcp parse: {e}"),
            }),
        }
    }
    // Top-level `~/.claude.json` (Claude Code's user-level config). Only the
    // root-level `mcpServers` key — per-project keys inside `projects` are
    // user toggles, not server defs.
    if let Some(home) = home_dir() {
        let user_json = home.join(".claude.json");
        if user_json.is_file() {
            match parse_mcp_from_settings(&user_json, Scope::Personal, None) {
                Ok(mut m) => mcps.append(&mut m),
                Err(e) => errors.push(ScanError {
                    path: user_json.to_string_lossy().to_string(),
                    message: format!("mcp(~/.claude.json) parse: {e}"),
                }),
            }
        }
    }
}

/// Internal struct passed to the closures so we don't re-stat / re-parse
/// inside the agent/command builders.
struct MdEntry {
    name: String,
    scope: Scope,
    project_root: Option<String>,
    path: PathBuf,
    modified_ms: i64,
    frontmatter: serde_json::Value,
    body: String,
}

fn scan_md_dir<F: FnMut(MdEntry)>(
    dir: &Path,
    scope: Scope,
    project_root: Option<&str>,
    mut push: F,
    errors: &mut Vec<ScanError>,
) {
    if !dir.is_dir() {
        return;
    }
    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            errors.push(ScanError {
                path: dir.to_string_lossy().to_string(),
                message: format!("read_dir: {e}"),
            });
            return;
        }
    };
    for entry in read_dir.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Only `.md`; skip `_archived-*` rendered hidden/dot-files.
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if name.starts_with('_') {
            continue;
        }
        match parse_md(&p) {
            Ok((fm, body)) => push(MdEntry {
                name,
                scope,
                project_root: project_root.map(|s| s.to_string()),
                path: p.clone(),
                modified_ms: mtime_ms(&p),
                frontmatter: fm,
                body,
            }),
            Err(e) => errors.push(ScanError {
                path: p.to_string_lossy().to_string(),
                message: format!("parse: {e}"),
            }),
        }
    }
}

fn scan_skills_dir(
    dir: &Path,
    scope: Scope,
    project_root: Option<&str>,
    skills: &mut Vec<SkillEntry>,
    errors: &mut Vec<ScanError>,
) {
    if !dir.is_dir() {
        return;
    }
    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            errors.push(ScanError {
                path: dir.to_string_lossy().to_string(),
                message: format!("read_dir: {e}"),
            });
            return;
        }
    };
    for entry in read_dir.flatten() {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() {
            continue;
        }
        let name = match skill_dir.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name.starts_with('_') || name.starts_with('.') {
            continue;
        }
        let skill_md = skill_dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        match parse_md(&skill_md) {
            Ok((fm, body)) => {
                let description = string_field(&fm, "description");
                let supporting_files = list_supporting_files(&skill_dir);
                skills.push(SkillEntry {
                    name,
                    scope,
                    project_root: project_root.map(|s| s.to_string()),
                    path: skill_md.to_string_lossy().to_string(),
                    dir_path: skill_dir.to_string_lossy().to_string(),
                    modified_ms: mtime_ms(&skill_md),
                    description,
                    frontmatter: fm,
                    body,
                    supporting_files,
                    overridden_by: None,
                });
            }
            Err(e) => errors.push(ScanError {
                path: skill_md.to_string_lossy().to_string(),
                message: format!("parse: {e}"),
            }),
        }
    }
}

fn list_supporting_files(skill_dir: &Path) -> Vec<SupportingFile> {
    let mut out = Vec::new();
    let read_dir = match std::fs::read_dir(skill_dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read_dir.flatten() {
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name == "SKILL.md" || name.starts_with('.') {
            continue;
        }
        if p.is_file() {
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            out.push(SupportingFile {
                name,
                path: p.to_string_lossy().to_string(),
                size,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn agent_from_md(e: MdEntry) -> AgentEntry {
    AgentEntry {
        name: e.name,
        scope: e.scope,
        project_root: e.project_root,
        path: e.path.to_string_lossy().to_string(),
        modified_ms: e.modified_ms,
        description: string_field(&e.frontmatter, "description"),
        model: string_field(&e.frontmatter, "model"),
        frontmatter: e.frontmatter,
        body: e.body,
        overridden_by: None,
    }
}

fn command_from_md(e: MdEntry) -> CommandEntry {
    CommandEntry {
        name: e.name,
        scope: e.scope,
        project_root: e.project_root,
        path: e.path.to_string_lossy().to_string(),
        modified_ms: e.modified_ms,
        description: string_field(&e.frontmatter, "description"),
        model: string_field(&e.frontmatter, "model"),
        argument_hint: string_field(&e.frontmatter, "argument-hint"),
        frontmatter: e.frontmatter,
        body: e.body,
        overridden_by: None,
    }
}

// ─── Hook parsing ───────────────────────────────────────────────────────────

pub(crate) fn parse_hooks_file(
    path: &Path,
    scope: Scope,
    project_root: Option<&str>,
) -> Result<Vec<HookEntry>> {
    let raw = std::fs::read_to_string(path).context("read settings file")?;
    let json: serde_json::Value = serde_json::from_str(&raw).context("parse settings json")?;
    let hooks_obj = match json.get("hooks") {
        Some(serde_json::Value::Object(m)) => m,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let settings_path_str = path.to_string_lossy().to_string();
    for (event, value) in hooks_obj {
        // Settings format: hooks: { Event: [ { matcher?, hooks: [ {type, command, ...} ] } ] }
        let groups = match value.as_array() {
            Some(g) => g,
            None => continue,
        };
        for group in groups {
            let inner = match group.get("hooks").and_then(|v| v.as_array()) {
                Some(a) => a,
                None => continue,
            };
            for h in inner {
                let kind = h
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("command")
                    .to_string();
                let command_raw = h
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let command_path = command_raw.as_ref().and_then(|c| {
                    let resolved = resolve_command_path(c, project_root);
                    resolved.map(|p| p.to_string_lossy().to_string())
                });
                let name = derive_hook_name(&command_raw, h);
                out.push(HookEntry {
                    event: event.clone(),
                    kind,
                    name,
                    scope,
                    project_root: project_root.map(|s| s.to_string()),
                    settings_path: settings_path_str.clone(),
                    command_path,
                    command_raw,
                    raw: h.clone(),
                });
            }
        }
    }
    Ok(out)
}

fn derive_hook_name(command_raw: &Option<String>, raw: &serde_json::Value) -> String {
    if let Some(c) = command_raw {
        // Take the first whitespace-separated token, basename.
        let first = c.split_whitespace().next().unwrap_or(c);
        if let Some(name) = std::path::Path::new(first)
            .file_name()
            .and_then(|s| s.to_str())
        {
            return name.to_string();
        }
        return first.to_string();
    }
    raw.get("matcher")
        .and_then(|v| v.as_str())
        .unwrap_or("hook")
        .to_string()
}

fn resolve_command_path(raw: &str, project_root: Option<&str>) -> Option<PathBuf> {
    let first = raw.split_whitespace().next().unwrap_or(raw);
    if first.is_empty() {
        return None;
    }
    if let Ok(p) = expand(first) {
        if p.is_absolute() && p.exists() {
            return Some(p);
        }
        if let Some(root) = project_root {
            if let Ok(rp) = expand(root) {
                let candidate = rp.join(first);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

// ─── MCP parsing ────────────────────────────────────────────────────────────

/// Parse a standalone `mcp.json` file (top level is `{ mcpServers: { ... } }`).
pub(crate) fn parse_mcp_file(
    path: &Path,
    scope: Scope,
    project_root: Option<&str>,
) -> Result<Vec<McpEntry>> {
    let raw = std::fs::read_to_string(path).context("read mcp file")?;
    let json: serde_json::Value = serde_json::from_str(&raw).context("parse mcp json")?;
    let servers = json.get("mcpServers").or_else(|| json.get("servers"));
    Ok(servers
        .and_then(|v| v.as_object())
        .map(|m| extract_mcp_servers(m, path, scope, project_root))
        .unwrap_or_default())
}

/// Parse `mcpServers` if it appears inside an arbitrary settings JSON file
/// (settings.local.json, settings.json, ~/.claude.json — anywhere it shows up
/// at the top level).
pub(crate) fn parse_mcp_from_settings(
    path: &Path,
    scope: Scope,
    project_root: Option<&str>,
) -> Result<Vec<McpEntry>> {
    let raw = std::fs::read_to_string(path).context("read settings file")?;
    let json: serde_json::Value = serde_json::from_str(&raw).context("parse settings json")?;
    let servers = match json.get("mcpServers").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return Ok(Vec::new()),
    };
    Ok(extract_mcp_servers(servers, path, scope, project_root))
}

fn extract_mcp_servers(
    servers: &serde_json::Map<String, serde_json::Value>,
    path: &Path,
    scope: Scope,
    project_root: Option<&str>,
) -> Vec<McpEntry> {
    let path_str = path.to_string_lossy().to_string();
    let mut out = Vec::with_capacity(servers.len());
    for (name, raw) in servers {
        let kind = raw.get("type").and_then(|v| v.as_str()).map(str::to_string);
        let url = raw.get("url").and_then(|v| v.as_str()).map(str::to_string);
        let command = raw
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let transport = if let Some(t) = kind {
            t
        } else if url.is_some() {
            "http".to_string()
        } else if command.is_some() {
            "stdio".to_string()
        } else {
            "unknown".to_string()
        };
        let args = raw
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let env_keys = raw
            .get("env")
            .and_then(|v| v.as_object())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        let header_keys = raw
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        out.push(McpEntry {
            name: name.clone(),
            scope,
            project_root: project_root.map(|s| s.to_string()),
            path: path_str.clone(),
            transport,
            command,
            args,
            env_keys,
            url,
            header_keys,
            raw: raw.clone(),
        });
    }
    out
}

// ─── Markdown / frontmatter parsing ─────────────────────────────────────────

pub(crate) fn parse_md(path: &Path) -> Result<(serde_json::Value, String)> {
    let raw = std::fs::read_to_string(path).context("read md")?;
    Ok(split_frontmatter(&raw))
}

/// Split a markdown file at the leading `---` frontmatter block. Returns
/// (frontmatter as JSON object, body string). If no frontmatter is present,
/// returns an empty object and the full file as body.
pub fn split_frontmatter(raw: &str) -> (serde_json::Value, String) {
    // Treat `---\n` or `---\r\n` as the opener; require it at the very start.
    let trimmed = raw.trim_start_matches('\u{FEFF}');
    if !trimmed.starts_with("---") {
        return (
            serde_json::Value::Object(Default::default()),
            raw.to_string(),
        );
    }
    // Find the line break after the opening fence.
    let after_open = match trimmed.find('\n') {
        Some(i) => &trimmed[i + 1..],
        None => {
            return (
                serde_json::Value::Object(Default::default()),
                raw.to_string(),
            )
        }
    };
    // Find the closing `---` on its own line.
    let mut close_idx: Option<usize> = None;
    let bytes = after_open.as_bytes();
    let mut line_start = 0usize;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' || i == bytes.len() - 1 {
            let end = if bytes[i] == b'\n' { i } else { i + 1 };
            let line = &after_open[line_start..end].trim_end_matches('\r');
            if *line == "---" {
                close_idx = Some(line_start);
                break;
            }
            line_start = i + 1;
        }
    }
    let close = match close_idx {
        Some(c) => c,
        None => {
            return (
                serde_json::Value::Object(Default::default()),
                raw.to_string(),
            )
        }
    };
    let yaml = &after_open[..close];
    // Body starts after the closing `---` line.
    let after_close = &after_open[close..];
    let body = match after_close.find('\n') {
        Some(i) => after_close[i + 1..].to_string(),
        None => String::new(),
    };
    let fm_json = match serde_yaml::from_str::<serde_yaml::Value>(yaml) {
        Ok(v) => yaml_to_json(v),
        Err(_) => serde_json::Value::Object(Default::default()),
    };
    let fm_json = match fm_json {
        serde_json::Value::Object(_) => fm_json,
        _ => serde_json::Value::Object(Default::default()),
    };
    (fm_json, body)
}

fn yaml_to_json(v: serde_yaml::Value) -> serde_json::Value {
    match v {
        serde_yaml::Value::Null => serde_json::Value::Null,
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::Number(serde_json::Number::from(i))
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            }
        }
        serde_yaml::Value::String(s) => serde_json::Value::String(s),
        serde_yaml::Value::Sequence(seq) => {
            serde_json::Value::Array(seq.into_iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    serde_yaml::Value::String(s) => s,
                    other => serde_yaml::to_string(&other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                };
                obj.insert(key, yaml_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        serde_yaml::Value::Tagged(t) => yaml_to_json(t.value),
    }
}

fn string_field(fm: &serde_json::Value, key: &str) -> Option<String> {
    fm.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

// ─── Override resolution ────────────────────────────────────────────────────

fn mark_overrides_agents(items: &mut [AgentEntry]) {
    let project_paths: std::collections::HashMap<String, String> = items
        .iter()
        .filter(|i| i.scope == Scope::Project)
        .map(|i| (i.name.clone(), i.path.clone()))
        .collect();
    for it in items.iter_mut() {
        if it.scope == Scope::Personal {
            if let Some(p) = project_paths.get(&it.name) {
                it.overridden_by = Some(p.clone());
            }
        }
    }
}
fn mark_overrides_skills(items: &mut [SkillEntry]) {
    let project_paths: std::collections::HashMap<String, String> = items
        .iter()
        .filter(|i| i.scope == Scope::Project)
        .map(|i| (i.name.clone(), i.path.clone()))
        .collect();
    for it in items.iter_mut() {
        if it.scope == Scope::Personal {
            if let Some(p) = project_paths.get(&it.name) {
                it.overridden_by = Some(p.clone());
            }
        }
    }
}
fn mark_overrides_commands(items: &mut [CommandEntry]) {
    let project_paths: std::collections::HashMap<String, String> = items
        .iter()
        .filter(|i| i.scope == Scope::Project)
        .map(|i| (i.name.clone(), i.path.clone()))
        .collect();
    for it in items.iter_mut() {
        if it.scope == Scope::Personal {
            if let Some(p) = project_paths.get(&it.name) {
                it.overridden_by = Some(p.clone());
            }
        }
    }
}

// ─── Path helpers ───────────────────────────────────────────────────────────

fn expand(input: &str) -> Result<PathBuf> {
    let s = shellexpand::full(input)
        .map(|c| c.into_owned())
        .map_err(|e| anyhow!("shellexpand: {e}"))?;
    Ok(PathBuf::from(s))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_under_claude_dir(p: &Path) -> bool {
    // Walk components: must contain a `.claude` segment somewhere.
    p.components().any(|c| match c {
        std::path::Component::Normal(s) => s == std::ffi::OsStr::new(".claude"),
        _ => false,
    })
}

// ─── Phase 4 — 4-tier discovery + pin CRUD (new surface) ────────────────────
//
// These commands sit alongside the legacy `claude_config_*` ones. The FE
// migrates incrementally — old `/claude` route keeps the legacy ones; new
// "Claude Config Browser" UI consumes the layered tree.

use crate::claude::discovery::{self, AssetPin, AssetTree};
use crate::commands::db::PaDb;
use crate::commands::projects::get_active_project_id;

fn validate_pin_scope(scope: &str) -> Result<(), String> {
    if scope == "workspace" {
        return Ok(());
    }
    if let Some(id) = scope.strip_prefix("project:") {
        if id.is_empty() || id.len() > 64 {
            return Err(format!("invalid project id length in scope {scope:?}"));
        }
        let mut chars = id.chars();
        let first = chars.next().unwrap();
        if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
            return Err(format!("invalid project id in scope {scope:?}"));
        }
        for c in chars {
            if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                return Err(format!("invalid project id in scope {scope:?}"));
            }
        }
        return Ok(());
    }
    Err(format!(
        "scope must be 'workspace' or 'project:<id>', got {scope:?}"
    ))
}

fn validate_pin_tier(tier: &str) -> Result<(), String> {
    match tier {
        "personal" | "workspace_pkg" | "project" | "project_pkg" => Ok(()),
        _ => Err(format!(
            "preferred_tier must be one of personal|workspace_pkg|project|project_pkg, got {tier:?}"
        )),
    }
}

fn validate_pin_kind(kind: &str) -> Result<(), String> {
    match kind {
        "skill" | "agent" | "command" | "hook" | "mcp" => Ok(()),
        _ => Err(format!(
            "asset_kind must be one of skill|agent|command|hook|mcp, got {kind:?}"
        )),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Run the 4-tier layered discovery.
///
/// `projectId` defaults to the currently-active project. The returned
/// `AssetTree` lists *all* sources for each asset name; consumers apply
/// `resolve_preferred` (or the equivalent FE helper) to pick the active one.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_assets_discover(
    app: AppHandle,
    db: State<'_, Arc<PaDb>>,
    projectId: Option<String>,
) -> Result<AssetTree, String> {
    let pool = db.ensure_pool().await?;
    let active = match projectId {
        Some(id) => id,
        None => get_active_project_id(&pool).await?,
    };
    discovery::discover(&active, &pool, &app).await
}

/// Insert / update a pin row. `preferredSource` is nullable for the personal
/// tier (there's only one personal source); for pkg tiers callers should pass
/// the pkg id so the pin can disambiguate between multiple pkgs declaring the
/// same asset name.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_asset_pin(
    db: State<'_, Arc<PaDb>>,
    scope: String,
    assetKind: String,
    assetName: String,
    preferredTier: String,
    preferredSource: Option<String>,
) -> Result<(), String> {
    validate_pin_scope(&scope)?;
    validate_pin_kind(&assetKind)?;
    validate_pin_tier(&preferredTier)?;
    if assetName.is_empty() || assetName.len() > 256 {
        return Err(format!(
            "invalid asset_name length: {} (1..=256)",
            assetName.len()
        ));
    }
    let pool = db.ensure_pool().await?;
    sqlx::query(
        "INSERT INTO claude_asset_preferences
            (scope, asset_kind, asset_name, preferred_tier, preferred_source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, asset_kind, asset_name) DO UPDATE SET
            preferred_tier   = excluded.preferred_tier,
            preferred_source = excluded.preferred_source,
            updated_at       = excluded.updated_at",
    )
    .bind(&scope)
    .bind(&assetKind)
    .bind(&assetName)
    .bind(&preferredTier)
    .bind(&preferredSource)
    .bind(now_ms())
    .execute(&pool)
    .await
    .map_err(|e| format!("upsert pin: {e}"))?;
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_asset_unpin(
    db: State<'_, Arc<PaDb>>,
    scope: String,
    assetKind: String,
    assetName: String,
) -> Result<(), String> {
    validate_pin_scope(&scope)?;
    validate_pin_kind(&assetKind)?;
    let pool = db.ensure_pool().await?;
    sqlx::query(
        "DELETE FROM claude_asset_preferences
         WHERE scope = ? AND asset_kind = ? AND asset_name = ?",
    )
    .bind(&scope)
    .bind(&assetKind)
    .bind(&assetName)
    .execute(&pool)
    .await
    .map_err(|e| format!("delete pin: {e}"))?;
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_asset_list_pins(
    db: State<'_, Arc<PaDb>>,
    scope: String,
) -> Result<Vec<AssetPin>, String> {
    validate_pin_scope(&scope)?;
    let pool = db.ensure_pool().await?;
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT scope, asset_kind, asset_name, preferred_tier, preferred_source, updated_at
         FROM claude_asset_preferences
         WHERE scope = ?
         ORDER BY asset_kind, asset_name",
    )
    .bind(&scope)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list pins: {e}"))?;
    let out = rows
        .into_iter()
        .map(|r| AssetPin {
            scope: r.get("scope"),
            asset_kind: r.get("asset_kind"),
            asset_name: r.get("asset_name"),
            preferred_tier: r.get("preferred_tier"),
            preferred_source: r.get("preferred_source"),
            updated_at: r.get("updated_at"),
        })
        .collect();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_simple() {
        let raw = "---\nname: x\nmodel: opus\n---\nbody here\n";
        let (fm, body) = split_frontmatter(raw);
        assert_eq!(fm["name"], "x");
        assert_eq!(fm["model"], "opus");
        assert_eq!(body, "body here\n");
    }

    #[test]
    fn frontmatter_with_list() {
        let raw = "---\nname: x\nallowed-tools:\n  - Task\n  - Read\n---\nhello\n";
        let (fm, body) = split_frontmatter(raw);
        assert_eq!(fm["allowed-tools"][0], "Task");
        assert_eq!(fm["allowed-tools"][1], "Read");
        assert_eq!(body, "hello\n");
    }

    #[test]
    fn no_frontmatter() {
        let raw = "# just markdown\n";
        let (fm, body) = split_frontmatter(raw);
        assert!(fm.is_object());
        assert_eq!(body, raw);
    }

    #[test]
    fn under_claude_dir() {
        assert!(is_under_claude_dir(Path::new("/x/y/.claude/agents/a.md")));
        assert!(is_under_claude_dir(Path::new(
            "/home/u/.claude/settings.json"
        )));
        assert!(!is_under_claude_dir(Path::new("/x/y/agents/a.md")));
    }

    #[test]
    fn pin_scope_validation() {
        assert!(validate_pin_scope("workspace").is_ok());
        assert!(validate_pin_scope("project:music-2026").is_ok());
        assert!(validate_pin_scope("project:default").is_ok());
        assert!(validate_pin_scope("personal").is_err());
        assert!(validate_pin_scope("project:").is_err());
        assert!(validate_pin_scope("project:BadCase").is_err());
        assert!(validate_pin_scope("workspace:x").is_err());
    }

    #[test]
    fn pin_tier_validation() {
        for t in &["personal", "workspace_pkg", "project", "project_pkg"] {
            assert!(validate_pin_tier(t).is_ok());
        }
        assert!(validate_pin_tier("workspace").is_err());
        assert!(validate_pin_tier("Personal").is_err());
    }

    #[test]
    fn pin_kind_validation() {
        for k in &["skill", "agent", "command", "hook", "mcp"] {
            assert!(validate_pin_kind(k).is_ok());
        }
        assert!(validate_pin_kind("Skill").is_err());
        assert!(validate_pin_kind("hooks").is_err());
    }
}
