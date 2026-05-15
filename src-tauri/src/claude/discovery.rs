//! 4-tier layered Claude-config discovery (Phase 4 of projects-first-class).
//!
//! Replaces the legacy 2-tier model (Project / Personal) with:
//!
//!   Tier 1 — Personal       (`~/.claude/{agents,skills,commands}/*` excluding
//!                            subdirs that belong to an installed pkg id).
//!   Tier 2 — Workspace pkg  (Kernel.list_installed() rows with project_id=None.
//!                            Files live at `~/.claude/<kind>/<pkg.id>/...`).
//!   Tier 3 — Active project (`<project.root_path>/.claude/...`).
//!   Tier 4 — Project pkg    (Kernel.list_installed() rows whose project_id
//!                            matches the active project).
//!
//! Default conflict resolution: lower tier wins (Personal beats WorkspacePkg
//! beats Project beats ProjectPkg). A `claude_asset_preferences` row (the
//! "pin") can override the default per (scope, kind, name).
//!
//! This module runs alongside the legacy `commands/claude_config.rs` scan —
//! the legacy Tauri commands stay registered so the existing /claude UI
//! keeps working. New callers go through `claude_assets_discover`.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::commands::claude_config::{
    parse_hooks_file, parse_mcp_file, parse_mcp_from_settings, HookEntry, McpEntry,
    Scope as LegacyScope,
};
use crate::commands::projects::get_project;

// ─── Public types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Personal,
    WorkspacePkg,
    Project,
    ProjectPkg,
}

impl Tier {
    /// Lower-tier-wins ordering for conflict resolution.
    pub fn precedence(self) -> u8 {
        match self {
            Tier::Personal => 0,
            Tier::WorkspacePkg => 1,
            Tier::Project => 2,
            Tier::ProjectPkg => 3,
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "personal" => Some(Tier::Personal),
            "workspace_pkg" => Some(Tier::WorkspacePkg),
            "project" => Some(Tier::Project),
            "project_pkg" => Some(Tier::ProjectPkg),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Personal => "personal",
            Tier::WorkspacePkg => "workspace_pkg",
            Tier::Project => "project",
            Tier::ProjectPkg => "project_pkg",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Skill,
    Agent,
    Command,
    Hook,
    Mcp,
}

impl AssetKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "skill" => Some(AssetKind::Skill),
            "agent" => Some(AssetKind::Agent),
            "command" => Some(AssetKind::Command),
            "hook" => Some(AssetKind::Hook),
            "mcp" => Some(AssetKind::Mcp),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AssetKind::Skill => "skill",
            AssetKind::Agent => "agent",
            AssetKind::Command => "command",
            AssetKind::Hook => "hook",
            AssetKind::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetSource {
    pub tier: Tier,
    /// pkg id, "personal", or "project:<id>".
    pub provider: String,
    /// Resolved file path (or sentinel for MCP entries — same as the legacy
    /// path field, e.g. the settings file the server was declared in).
    pub path: String,
    pub name: String,
    pub kind: AssetKind,
}

#[derive(Debug, Default, Serialize)]
pub struct AssetTree {
    pub skills: HashMap<String, Vec<AssetSource>>,
    pub agents: HashMap<String, Vec<AssetSource>>,
    pub commands: HashMap<String, Vec<AssetSource>>,
    pub hooks: HashMap<String, Vec<AssetSource>>,
    pub mcps: HashMap<String, Vec<AssetSource>>,
}

/// `(asset_kind, asset_name) -> (preferred_tier, preferred_source)`.
pub type PinMap = HashMap<(AssetKind, String), (Tier, Option<String>)>;

// ─── Discovery entry point ─────────────────────────────────────────────────

/// Run the 4-tier discovery walk. `active_project_id` selects which project
/// rows populate tier 3 + 4; pass `"default"` (or the result of
/// `get_active_project_id`) for the active session.
///
/// Best-effort: bad files are silently skipped (the legacy scan surfaces them
/// in `errors`, we don't have a place for those here yet). FE/MCP callers
/// that need diagnostics should also call `claude_config_load`.
pub async fn discover(
    active_project_id: &str,
    pool: &SqlitePool,
    app: &AppHandle,
) -> Result<AssetTree, String> {
    // Snapshot installed pkgs up front so we can split them by tier and use
    // the id set as a filter against personal-tier files.
    let kernel: tauri::State<crate::commands::pkg::KernelState> = app.state();
    let installed = kernel.0.list_installed();
    let installed_ids: HashSet<String> = installed.iter().map(|s| s.id.clone()).collect();

    let mut tree = AssetTree::default();

    // ── Tier 1: Personal ──────────────────────────────────────────────────
    if let Some(home) = home_dir() {
        let personal = home.join(".claude");
        if personal.is_dir() {
            scan_personal_files(&personal, &installed_ids, &mut tree);
            // Settings.json hooks + mcpServers (top-level only).
            let p = personal.join("settings.json");
            if p.is_file() {
                push_hooks(
                    &p,
                    LegacyScope::Personal,
                    None,
                    Tier::Personal,
                    "personal",
                    &mut tree,
                );
                push_mcps_from_settings(
                    &p,
                    LegacyScope::Personal,
                    None,
                    Tier::Personal,
                    "personal",
                    &mut tree,
                );
            }
            // Personal mcp.json
            let mcp_json = personal.join("mcp.json");
            if mcp_json.is_file() {
                push_mcps_from_mcp_file(
                    &mcp_json,
                    LegacyScope::Personal,
                    None,
                    Tier::Personal,
                    "personal",
                    &mut tree,
                );
            }
            // Top-level ~/.claude.json (Claude Code user-level config) — only
            // root-level mcpServers.
            let user_json = home.join(".claude.json");
            if user_json.is_file() {
                push_mcps_from_settings(
                    &user_json,
                    LegacyScope::Personal,
                    None,
                    Tier::Personal,
                    "personal",
                    &mut tree,
                );
            }
        }
    }

    // ── Tier 2 + 4: Pkg contributions ────────────────────────────────────
    for summary in &installed {
        let tier = match &summary.project_id {
            None => Tier::WorkspacePkg,
            Some(pid) if pid == active_project_id => Tier::ProjectPkg,
            Some(_) => continue, // inactive project pkg — invisible this session
        };
        scan_pkg_contributions(&summary.id, tier, &mut tree);
        // Manifest mcp[] entries — load manifest and surface each server.
        scan_pkg_mcps(summary, tier, &mut tree);
    }

    // ── Tier 3: Active project ───────────────────────────────────────────
    if let Some(project) = get_project(pool, active_project_id).await.ok().flatten() {
        if let Some(root) = project.root_path.as_deref() {
            if let Ok(root_path) = expand(root) {
                let claude = root_path.join(".claude");
                if claude.is_dir() {
                    let provider = format!("project:{}", project.id);
                    scan_project_files(&claude, &project.id, &provider, &mut tree);

                    for f in ["settings.local.json", "settings.json"] {
                        let p = claude.join(f);
                        if p.is_file() {
                            push_hooks(
                                &p,
                                LegacyScope::Project,
                                Some(&root_path.to_string_lossy()),
                                Tier::Project,
                                &provider,
                                &mut tree,
                            );
                            push_mcps_from_settings(
                                &p,
                                LegacyScope::Project,
                                Some(&root_path.to_string_lossy()),
                                Tier::Project,
                                &provider,
                                &mut tree,
                            );
                        }
                    }
                    let mcp_json = claude.join("mcp.json");
                    if mcp_json.is_file() {
                        push_mcps_from_mcp_file(
                            &mcp_json,
                            LegacyScope::Project,
                            Some(&root_path.to_string_lossy()),
                            Tier::Project,
                            &provider,
                            &mut tree,
                        );
                    }
                }
            }
        }
    }

    // Sort each entry's source vec by tier precedence for stable ordering.
    for sources in tree
        .skills
        .values_mut()
        .chain(tree.agents.values_mut())
        .chain(tree.commands.values_mut())
        .chain(tree.hooks.values_mut())
        .chain(tree.mcps.values_mut())
    {
        sources.sort_by_key(|s| s.tier.precedence());
    }

    Ok(tree)
}

// ─── Tier 1 — personal scanning ────────────────────────────────────────────

/// Walk `~/.claude/{agents,skills,commands}/`. Subdirs whose name matches an
/// installed pkg id are skipped (those are tier 2/4 contributions).
fn scan_personal_files(personal: &Path, installed_ids: &HashSet<String>, tree: &mut AssetTree) {
    // Agents: `~/.claude/agents/*.md` (top-level only — subdirs belong to pkgs).
    scan_kind_personal(
        &personal.join("agents"),
        AssetKind::Agent,
        installed_ids,
        tree,
    );
    // Commands: same shape.
    scan_kind_personal(
        &personal.join("commands"),
        AssetKind::Command,
        installed_ids,
        tree,
    );
    // Skills: `~/.claude/skills/<name>/SKILL.md`. Skill `<name>` matching an
    // installed pkg id is a pkg-provided skill.
    let skills_dir = personal.join("skills");
    if skills_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&skills_dir) {
            for entry in rd.flatten() {
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
                if installed_ids.contains(&name) {
                    continue;
                }
                let skill_md = skill_dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                push_source(
                    &mut tree.skills,
                    AssetSource {
                        tier: Tier::Personal,
                        provider: "personal".into(),
                        path: skill_md.to_string_lossy().to_string(),
                        name: name.clone(),
                        kind: AssetKind::Skill,
                    },
                );
            }
        }
    }
}

fn scan_kind_personal(
    dir: &Path,
    kind: AssetKind,
    installed_ids: &HashSet<String>,
    tree: &mut AssetTree,
) {
    if !dir.is_dir() {
        return;
    }
    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let p = entry.path();
        // Skip pkg subdirs (their `<pkg-id>/...` files surface via tier 2/4).
        if p.is_dir() {
            continue;
        }
        if !p.is_file() {
            continue;
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if name.starts_with('_') {
            continue;
        }
        // Defensive: a flat file whose stem matches a pkg id is still
        // personal (it can't have been installed by a pkg because the
        // installer writes to a subdir). No-op here, but reading the rule
        // out loud: only directories named after a pkg id are excluded.
        let _ = installed_ids;
        let map = match kind {
            AssetKind::Agent => &mut tree.agents,
            AssetKind::Command => &mut tree.commands,
            _ => unreachable!("scan_kind_personal called with non-md kind"),
        };
        push_source(
            map,
            AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: p.to_string_lossy().to_string(),
                name,
                kind,
            },
        );
    }
}

// ─── Tier 2 + 4 — pkg contributions ────────────────────────────────────────

/// Walk `~/.claude/<kind>/<pkg_id>/...` for one installed pkg.
fn scan_pkg_contributions(pkg_id: &str, tier: Tier, tree: &mut AssetTree) {
    let Some(home) = home_dir() else { return };
    let personal = home.join(".claude");
    for (subdir, kind, map) in [
        ("agents", AssetKind::Agent, "agents"),
        ("commands", AssetKind::Command, "commands"),
    ] {
        let _ = map;
        let pkg_dir = personal.join(subdir).join(pkg_id);
        if !pkg_dir.is_dir() {
            continue;
        }
        scan_md_recursive(&pkg_dir, pkg_id, tier, kind, tree);
    }
    // Skills: `~/.claude/skills/<pkg_id>/<skill_name>/SKILL.md` (one level).
    let skills_root = personal.join("skills").join(pkg_id);
    if skills_root.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&skills_root) {
            for entry in rd.flatten() {
                let skill_dir = entry.path();
                if !skill_dir.is_dir() {
                    // pkg could ship a flat SKILL.md too — handle that case
                    // by treating the pkg dir itself as the skill.
                    continue;
                }
                let name = match skill_dir.file_name().and_then(|s| s.to_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let skill_md = skill_dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                push_source(
                    &mut tree.skills,
                    AssetSource {
                        tier,
                        provider: pkg_id.to_string(),
                        path: skill_md.to_string_lossy().to_string(),
                        name,
                        kind: AssetKind::Skill,
                    },
                );
            }
            // Also handle the case where the pkg-id dir itself is the skill
            // (single-skill pkg with a flat SKILL.md).
            let flat = skills_root.join("SKILL.md");
            if flat.is_file() {
                push_source(
                    &mut tree.skills,
                    AssetSource {
                        tier,
                        provider: pkg_id.to_string(),
                        path: flat.to_string_lossy().to_string(),
                        name: pkg_id.to_string(),
                        kind: AssetKind::Skill,
                    },
                );
            }
        }
    }
}

fn scan_md_recursive(dir: &Path, pkg_id: &str, tier: Tier, kind: AssetKind, tree: &mut AssetTree) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_md_recursive(&p, pkg_id, tier, kind, tree);
            continue;
        }
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name.starts_with('_') {
            continue;
        }
        let map = match kind {
            AssetKind::Agent => &mut tree.agents,
            AssetKind::Command => &mut tree.commands,
            _ => unreachable!("scan_md_recursive expects agent or command"),
        };
        push_source(
            map,
            AssetSource {
                tier,
                provider: pkg_id.to_string(),
                path: p.to_string_lossy().to_string(),
                name,
                kind,
            },
        );
    }
}

/// Surface the pkg's manifest `mcp[]` entries as tier-tagged MCP sources.
fn scan_pkg_mcps(summary: &crate::pkg::kernel::InstalledSummary, tier: Tier, tree: &mut AssetTree) {
    let manifest_path = Path::new(&summary.install_path).join("manifest.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let manifest: crate::pkg::manifest::Manifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(_) => return,
    };
    let path_str = manifest_path.to_string_lossy().to_string();
    for server in &manifest.mcp {
        push_source(
            &mut tree.mcps,
            AssetSource {
                tier,
                provider: summary.id.clone(),
                path: path_str.clone(),
                name: server.name.clone(),
                kind: AssetKind::Mcp,
            },
        );
    }
}

// ─── Tier 3 — project-rooted files ─────────────────────────────────────────

fn scan_project_files(claude: &Path, project_id: &str, provider: &str, tree: &mut AssetTree) {
    let _ = project_id;
    // Agents.
    if let Ok(rd) = std::fs::read_dir(claude.join("agents")) {
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let name = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if name.starts_with('_') {
                continue;
            }
            push_source(
                &mut tree.agents,
                AssetSource {
                    tier: Tier::Project,
                    provider: provider.to_string(),
                    path: p.to_string_lossy().to_string(),
                    name,
                    kind: AssetKind::Agent,
                },
            );
        }
    }
    // Commands.
    if let Ok(rd) = std::fs::read_dir(claude.join("commands")) {
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let name = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if name.starts_with('_') {
                continue;
            }
            push_source(
                &mut tree.commands,
                AssetSource {
                    tier: Tier::Project,
                    provider: provider.to_string(),
                    path: p.to_string_lossy().to_string(),
                    name,
                    kind: AssetKind::Command,
                },
            );
        }
    }
    // Skills.
    let skills_dir = claude.join("skills");
    if let Ok(rd) = std::fs::read_dir(&skills_dir) {
        for entry in rd.flatten() {
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
            push_source(
                &mut tree.skills,
                AssetSource {
                    tier: Tier::Project,
                    provider: provider.to_string(),
                    path: skill_md.to_string_lossy().to_string(),
                    name,
                    kind: AssetKind::Skill,
                },
            );
        }
    }
}

// ─── Hook + MCP helpers (wrap legacy parsers) ──────────────────────────────

fn push_hooks(
    path: &Path,
    scope: LegacyScope,
    project_root: Option<&str>,
    tier: Tier,
    provider: &str,
    tree: &mut AssetTree,
) {
    let Ok(entries) = parse_hooks_file(path, scope, project_root) else {
        return;
    };
    for h in entries {
        // Synthesize a stable name: "<event>/<name>".
        let name = format!("{}/{}", h.event, hook_name(&h));
        push_source(
            &mut tree.hooks,
            AssetSource {
                tier,
                provider: provider.to_string(),
                path: hook_path(&h),
                name,
                kind: AssetKind::Hook,
            },
        );
    }
}

fn hook_name(h: &HookEntry) -> &str {
    h.name.as_str()
}

fn hook_path(h: &HookEntry) -> String {
    h.command_path
        .clone()
        .unwrap_or_else(|| h.settings_path.clone())
}

fn push_mcps_from_settings(
    path: &Path,
    scope: LegacyScope,
    project_root: Option<&str>,
    tier: Tier,
    provider: &str,
    tree: &mut AssetTree,
) {
    let Ok(entries) = parse_mcp_from_settings(path, scope, project_root) else {
        return;
    };
    push_mcps_inner(entries, tier, provider, tree);
}

fn push_mcps_from_mcp_file(
    path: &Path,
    scope: LegacyScope,
    project_root: Option<&str>,
    tier: Tier,
    provider: &str,
    tree: &mut AssetTree,
) {
    let Ok(entries) = parse_mcp_file(path, scope, project_root) else {
        return;
    };
    push_mcps_inner(entries, tier, provider, tree);
}

fn push_mcps_inner(entries: Vec<McpEntry>, tier: Tier, provider: &str, tree: &mut AssetTree) {
    for m in entries {
        push_source(
            &mut tree.mcps,
            AssetSource {
                tier,
                provider: provider.to_string(),
                path: m.path,
                name: m.name,
                kind: AssetKind::Mcp,
            },
        );
    }
}

// ─── Generic helpers ───────────────────────────────────────────────────────

fn push_source(map: &mut HashMap<String, Vec<AssetSource>>, src: AssetSource) {
    map.entry(src.name.clone()).or_default().push(src);
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn expand(input: &str) -> Result<PathBuf, String> {
    shellexpand::full(input)
        .map(|c| PathBuf::from(c.into_owned()))
        .map_err(|e| format!("shellexpand: {e}"))
}

// ─── Pin resolution ────────────────────────────────────────────────────────

/// Pick the preferred source for an asset given the current pin map.
///
/// Default behaviour: lowest tier wins (precedence asc).
/// Pin behaviour: pin matches a source iff its `tier` is `preferred_tier`
/// AND (preferred_source is None OR source.provider == preferred_source).
pub fn resolve_preferred<'a>(
    name: &str,
    sources: &'a [AssetSource],
    pins: &PinMap,
) -> &'a AssetSource {
    debug_assert!(!sources.is_empty(), "resolve_preferred on empty sources");
    if sources.len() == 1 {
        return &sources[0];
    }
    let kind = sources[0].kind;
    if let Some((tier, provider)) = pins.get(&(kind, name.to_string())) {
        if let Some(s) = sources
            .iter()
            .find(|s| s.tier == *tier && provider.as_deref().map_or(true, |p| s.provider == p))
        {
            return s;
        }
    }
    sources
        .iter()
        .min_by_key(|s| s.tier.precedence())
        .expect("non-empty by debug_assert")
}

// ─── Pin storage helpers ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetPin {
    pub scope: String,
    pub asset_kind: String,
    pub asset_name: String,
    pub preferred_tier: String,
    pub preferred_source: Option<String>,
    pub updated_at: i64,
}

/// Load every pin for a scope, indexed by `(kind, name)` so callers can look
/// up directly.
pub async fn load_pins(pool: &SqlitePool, scope: &str) -> Result<PinMap, String> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT asset_kind, asset_name, preferred_tier, preferred_source
         FROM claude_asset_preferences
         WHERE scope = ?",
    )
    .bind(scope)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("load pins: {e}"))?;
    let mut out: PinMap = HashMap::new();
    for r in rows {
        let kind_str: String = r.get("asset_kind");
        let name: String = r.get("asset_name");
        let tier_str: String = r.get("preferred_tier");
        let source: Option<String> = r.get("preferred_source");
        let (Some(kind), Some(tier)) = (AssetKind::from_str(&kind_str), Tier::from_str(&tier_str))
        else {
            continue;
        };
        out.insert((kind, name), (tier, source));
    }
    Ok(out)
}

// ─── Per-session symlinked config dir builder ─────────────────────────────

/// Build a per-session config dir at `<app_cache>/sessions/<session_id>/.claude/`
/// with subdirs `agents/`, `skills/`, `commands/`, `hooks/`. Each resolved
/// preferred provider is symlinked into the matching subdir. Returns the
/// absolute path to the `.claude/` dir.
///
/// Symlinks point to the real files (or skill dirs); claude reads them via
/// its existing config-dir scan. Cleanup is the caller's responsibility
/// (delete the dir on session end).
pub fn build_session_config_dir(
    app: &AppHandle,
    session_id: &str,
    tree: &AssetTree,
    pins: &PinMap,
) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    let claude_dir = cache_dir.join("sessions").join(session_id).join(".claude");
    // Fresh dir per session — wipe if it already exists (stale prior session).
    if claude_dir.exists() {
        std::fs::remove_dir_all(&claude_dir).map_err(|e| format!("clean: {e}"))?;
    }
    for sub in ["agents", "skills", "commands", "hooks"] {
        std::fs::create_dir_all(claude_dir.join(sub)).map_err(|e| format!("mkdir {sub}: {e}"))?;
    }

    for (name, sources) in &tree.agents {
        let pick = resolve_preferred(name, sources, pins);
        link_into(
            &claude_dir.join("agents"),
            Path::new(&pick.path),
            name,
            "md",
        )?;
    }
    for (name, sources) in &tree.commands {
        let pick = resolve_preferred(name, sources, pins);
        link_into(
            &claude_dir.join("commands"),
            Path::new(&pick.path),
            name,
            "md",
        )?;
    }
    for (name, sources) in &tree.skills {
        let pick = resolve_preferred(name, sources, pins);
        // Skill path points at SKILL.md; link the parent dir under skills/<name>/.
        let skill_md = Path::new(&pick.path);
        if let Some(parent) = skill_md.parent() {
            let dst = claude_dir.join("skills").join(name);
            // No extension for dir symlinks.
            make_symlink(parent, &dst)?;
        }
    }
    // Hooks: we currently don't synthesize a `hooks/<event>.json` file —
    // hooks live inside settings.json and need to be re-merged for the
    // session. Phase 5 may emit a synthesized settings.json here. For now
    // the hooks/ subdir exists but stays empty.

    write_merged_mcp_config(&claude_dir, &tree.mcps, pins)?;

    Ok(claude_dir)
}

/// Write the merged MCP-server set into `<claude_dir>/.mcp.json`.
///
/// Walks `tree.mcps`, applies pin resolution per name, and re-parses each
/// pick's source file to recover the original `mcpServers.<name>` entry.
/// The output is the same shape claude reads natively: a JSON object with
/// a top-level `mcpServers` key. spawn-time wiring should pass this file
/// via `--mcp-config <path> --strict-mcp-config` so claude uses *only* the
/// merged set and skips its own discovery (which would re-add personal +
/// project servers, double-counting them).
///
/// Returns Ok with no file written if the merged set is empty.
fn write_merged_mcp_config(
    claude_dir: &Path,
    mcps: &HashMap<String, Vec<AssetSource>>,
    pins: &PinMap,
) -> Result<(), String> {
    let mut servers = serde_json::Map::new();
    for (name, sources) in mcps {
        let pick = resolve_preferred(name, sources, pins);
        let Ok(raw) = std::fs::read_to_string(&pick.path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let entry = json
            .get("mcpServers")
            .or_else(|| json.get("servers"))
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(name));
        if let Some(entry) = entry {
            servers.insert(name.clone(), entry.clone());
        }
    }
    if servers.is_empty() {
        return Ok(());
    }
    let out = serde_json::json!({ "mcpServers": servers });
    let bytes = serde_json::to_vec_pretty(&out).map_err(|e| format!("mcp json: {e}"))?;
    std::fs::write(claude_dir.join(".mcp.json"), bytes).map_err(|e| format!("write .mcp.json: {e}"))
}

fn link_into(dst_dir: &Path, src: &Path, name: &str, ext: &str) -> Result<(), String> {
    let dst = dst_dir.join(format!("{name}.{ext}"));
    make_symlink(src, &dst)
}

fn make_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    // If dst already exists (re-run on same session id), drop it first.
    if dst.exists() || dst.is_symlink() {
        let _ = if dst.is_dir() && !dst.is_symlink() {
            std::fs::remove_dir_all(dst)
        } else {
            std::fs::remove_file(dst)
        };
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
            .map_err(|e| format!("symlink {} -> {}: {e}", dst.display(), src.display()))
    }
    #[cfg(windows)]
    {
        // Normal users on Windows can't make symlinks without Developer
        // Mode — fall back to a recursive copy (files) or copy_dir.
        if src.is_dir() {
            copy_dir_recursive(src, dst).map_err(|e| format!("copy_dir: {e}"))
        } else {
            std::fs::copy(src, dst)
                .map(|_| ())
                .map_err(|e| format!("copy: {e}"))
        }
    }
}

#[cfg(windows)]
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_precedence_order() {
        assert!(Tier::Personal.precedence() < Tier::WorkspacePkg.precedence());
        assert!(Tier::WorkspacePkg.precedence() < Tier::Project.precedence());
        assert!(Tier::Project.precedence() < Tier::ProjectPkg.precedence());
    }

    #[test]
    fn resolve_default_is_lowest_tier() {
        let sources = vec![
            AssetSource {
                tier: Tier::ProjectPkg,
                provider: "p".into(),
                path: "/p".into(),
                name: "x".into(),
                kind: AssetKind::Skill,
            },
            AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: "/h".into(),
                name: "x".into(),
                kind: AssetKind::Skill,
            },
        ];
        let pins = PinMap::new();
        let picked = resolve_preferred("x", &sources, &pins);
        assert_eq!(picked.tier, Tier::Personal);
    }

    #[test]
    fn pin_overrides_default() {
        let sources = vec![
            AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: "/h".into(),
                name: "x".into(),
                kind: AssetKind::Skill,
            },
            AssetSource {
                tier: Tier::Project,
                provider: "project:music".into(),
                path: "/m".into(),
                name: "x".into(),
                kind: AssetKind::Skill,
            },
        ];
        let mut pins = PinMap::new();
        pins.insert((AssetKind::Skill, "x".into()), (Tier::Project, None));
        let picked = resolve_preferred("x", &sources, &pins);
        assert_eq!(picked.tier, Tier::Project);
    }

    #[test]
    fn pin_with_provider_matches_exact() {
        let sources = vec![
            AssetSource {
                tier: Tier::WorkspacePkg,
                provider: "com.example.a".into(),
                path: "/a".into(),
                name: "x".into(),
                kind: AssetKind::Agent,
            },
            AssetSource {
                tier: Tier::WorkspacePkg,
                provider: "com.example.b".into(),
                path: "/b".into(),
                name: "x".into(),
                kind: AssetKind::Agent,
            },
        ];
        let mut pins = PinMap::new();
        pins.insert(
            (AssetKind::Agent, "x".into()),
            (Tier::WorkspacePkg, Some("com.example.b".into())),
        );
        let picked = resolve_preferred("x", &sources, &pins);
        assert_eq!(picked.provider, "com.example.b");
    }

    #[test]
    fn pin_with_missing_target_falls_back_to_default() {
        let sources = vec![
            AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: "/h".into(),
                name: "x".into(),
                kind: AssetKind::Command,
            },
            AssetSource {
                tier: Tier::WorkspacePkg,
                provider: "com.x".into(),
                path: "/p".into(),
                name: "x".into(),
                kind: AssetKind::Command,
            },
        ];
        let mut pins = PinMap::new();
        // Pin says ProjectPkg but no such source exists.
        pins.insert((AssetKind::Command, "x".into()), (Tier::ProjectPkg, None));
        let picked = resolve_preferred("x", &sources, &pins);
        assert_eq!(picked.tier, Tier::Personal);
    }

    #[cfg(unix)]
    #[test]
    fn session_dir_builder_creates_expected_layout() {
        use std::io::Write;

        // Spin up a temp dir to act as the "real" asset source.
        let tmp = std::env::temp_dir().join(format!(
            "ikenga-claude-discovery-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let agent_path = tmp.join("agent-a.md");
        let mut f = std::fs::File::create(&agent_path).unwrap();
        f.write_all(b"---\nname: a\n---\nbody").unwrap();

        let cmd_path = tmp.join("cmd-b.md");
        let mut f = std::fs::File::create(&cmd_path).unwrap();
        f.write_all(b"---\nname: b\n---\nbody").unwrap();

        let skill_dir = tmp.join("skill-c");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let mut f = std::fs::File::create(skill_dir.join("SKILL.md")).unwrap();
        f.write_all(b"---\nname: c\n---\nbody").unwrap();

        // Build an AssetTree by hand.
        let mut tree = AssetTree::default();
        tree.agents.insert(
            "a".into(),
            vec![AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: agent_path.to_string_lossy().to_string(),
                name: "a".into(),
                kind: AssetKind::Agent,
            }],
        );
        tree.commands.insert(
            "b".into(),
            vec![AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: cmd_path.to_string_lossy().to_string(),
                name: "b".into(),
                kind: AssetKind::Command,
            }],
        );
        tree.skills.insert(
            "c".into(),
            vec![AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: skill_dir.join("SKILL.md").to_string_lossy().to_string(),
                name: "c".into(),
                kind: AssetKind::Skill,
            }],
        );

        // We can't use AppHandle in a unit test — so exercise the layout
        // step manually using the same target dir shape.
        let dst_root = tmp.join("session-out").join(".claude");
        for sub in ["agents", "skills", "commands", "hooks"] {
            std::fs::create_dir_all(dst_root.join(sub)).unwrap();
        }
        let pins = PinMap::new();
        for (name, sources) in &tree.agents {
            let pick = resolve_preferred(name, sources, &pins);
            make_symlink(
                Path::new(&pick.path),
                &dst_root.join("agents").join(format!("{name}.md")),
            )
            .unwrap();
        }
        for (name, sources) in &tree.commands {
            let pick = resolve_preferred(name, sources, &pins);
            make_symlink(
                Path::new(&pick.path),
                &dst_root.join("commands").join(format!("{name}.md")),
            )
            .unwrap();
        }
        for (name, sources) in &tree.skills {
            let pick = resolve_preferred(name, sources, &pins);
            let skill_md = Path::new(&pick.path);
            let parent = skill_md.parent().unwrap();
            make_symlink(parent, &dst_root.join("skills").join(name)).unwrap();
        }

        assert!(dst_root.join("agents/a.md").exists());
        assert!(dst_root.join("commands/b.md").exists());
        assert!(dst_root.join("skills/c/SKILL.md").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_merged_mcp_config_merges_and_resolves_pins() {
        use std::io::Write;

        let tmp =
            std::env::temp_dir().join(format!("ikenga-mcp-merge-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Personal settings.json with mcpServers.alpha + shared.
        let personal_settings = tmp.join("personal-settings.json");
        let mut f = std::fs::File::create(&personal_settings).unwrap();
        f.write_all(
            br#"{
              "mcpServers": {
                "alpha": { "command": "alpha-bin", "args": ["--personal"] },
                "shared": { "command": "shared-personal", "args": [] }
              }
            }"#,
        )
        .unwrap();

        // Project-pkg .mcp.json with mcpServers.beta + shared (project_pkg variant).
        let project_pkg_mcp = tmp.join("project-pkg-mcp.json");
        let mut f = std::fs::File::create(&project_pkg_mcp).unwrap();
        f.write_all(
            br#"{
              "mcpServers": {
                "beta": { "command": "beta-bin", "args": [] },
                "shared": { "command": "shared-project-pkg", "args": [] }
              }
            }"#,
        )
        .unwrap();

        let mut tree = AssetTree::default();
        // alpha — only personal
        tree.mcps.insert(
            "alpha".into(),
            vec![AssetSource {
                tier: Tier::Personal,
                provider: "personal".into(),
                path: personal_settings.to_string_lossy().to_string(),
                name: "alpha".into(),
                kind: AssetKind::Mcp,
            }],
        );
        // beta — only project_pkg
        tree.mcps.insert(
            "beta".into(),
            vec![AssetSource {
                tier: Tier::ProjectPkg,
                provider: "com.example.beta-pkg".into(),
                path: project_pkg_mcp.to_string_lossy().to_string(),
                name: "beta".into(),
                kind: AssetKind::Mcp,
            }],
        );
        // shared — conflict: personal + project_pkg
        tree.mcps.insert(
            "shared".into(),
            vec![
                AssetSource {
                    tier: Tier::Personal,
                    provider: "personal".into(),
                    path: personal_settings.to_string_lossy().to_string(),
                    name: "shared".into(),
                    kind: AssetKind::Mcp,
                },
                AssetSource {
                    tier: Tier::ProjectPkg,
                    provider: "com.example.beta-pkg".into(),
                    path: project_pkg_mcp.to_string_lossy().to_string(),
                    name: "shared".into(),
                    kind: AssetKind::Mcp,
                },
            ],
        );

        let claude_dir = tmp.join("session-out").join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Default resolution: lowest tier (Personal) wins for `shared`.
        write_merged_mcp_config(&claude_dir, &tree.mcps, &PinMap::new()).unwrap();
        let written = std::fs::read_to_string(claude_dir.join(".mcp.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        let servers = parsed
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .unwrap();
        assert!(servers.contains_key("alpha"));
        assert!(servers.contains_key("beta"));
        assert_eq!(
            servers["shared"]["command"].as_str().unwrap(),
            "shared-personal"
        );

        // Pin shared -> ProjectPkg.
        let mut pins = PinMap::new();
        pins.insert((AssetKind::Mcp, "shared".into()), (Tier::ProjectPkg, None));
        write_merged_mcp_config(&claude_dir, &tree.mcps, &pins).unwrap();
        let written = std::fs::read_to_string(claude_dir.join(".mcp.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        let servers = parsed
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .unwrap();
        assert_eq!(
            servers["shared"]["command"].as_str().unwrap(),
            "shared-project-pkg"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_merged_mcp_config_skips_empty() {
        let tmp =
            std::env::temp_dir().join(format!("ikenga-mcp-empty-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let claude_dir = tmp.join("session-out").join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let empty: HashMap<String, Vec<AssetSource>> = HashMap::new();
        write_merged_mcp_config(&claude_dir, &empty, &PinMap::new()).unwrap();
        assert!(!claude_dir.join(".mcp.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
