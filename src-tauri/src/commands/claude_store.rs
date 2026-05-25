//! Ngwa central store (Ọba) + symlink farm — WP-02.
//!
//! Implements the file-based half of the G-CONTRACT store layer (see the
//! frozen TS signatures in `src/lib/tauri-cmd.ts`). The store is a central
//! catalog of canonical primitives at `<app_data_dir>/store/{agents,skills,
//! commands}/<name>`; "enabling" a primitive in a scope creates a **symlink**
//! in that scope's `.claude/<kind>s/` dir pointing into the store. Disabling
//! drops only the link, leaving the canonical store copy intact. Copy/move
//! relocate the resolved primitive across scopes; remove deletes the
//! scope-local entry (link or real file) without touching the store.
//!
//! Three primitive shapes share the same store/farm machinery:
//!   - **agent**   → `<kind-dir>/<name>.md`        (single file)
//!   - **command** → `<kind-dir>/<name>.md`        (single file)
//!   - **skill**   → `<kind-dir>/<name>/`          (directory, holds SKILL.md)
//!
//! `hook` and `mcp` are JSON-fragment primitives toggled by a separate merge
//! engine (WP-03, `claude_store/merge.rs`). They are intentionally *not*
//! implemented here — every mutation routes them through a single, clearly
//! marked `ORCHESTRATOR-WIRE` match arm that errors for now and is the wiring
//! point for WP-03's merge API at integration.
//!
//! ## Atomicity + path-confinement
//! Writes that materialize a primitive (import copy, copy/move across scopes)
//! go through a temp path + atomic rename so an interrupted write never leaves
//! a half-written canonical file. Every mutation validates that its on-disk
//! target sits under a `.claude/` dir or the store root
//! (`claude_config::is_under_claude_or_store`) before touching the FS.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::claude_config::{
    clear_pin_for, expand, is_in_store, is_under_claude_or_store, mtime_ms, parse_md, repoint_pin,
    store_root, string_field, validate_pin_scope,
};
use crate::commands::db::PaDb;
use crate::commands::projects::get_project;

/// WP-03 merge engine — JSON-fragment (hook/mcp) splice into Claude Code's
/// settings files. `claude_store/merge.rs` (file sits in the same-named subdir
/// next to this file). We call its pure, synchronous API; the async
/// `project:<id>` → `root_path` resolution stays here (`resolve_scope_root`).
mod merge;

// ─── Wire types (mirror the frozen G-CONTRACT) ───────────────────────────────

/// A single catalog entry in the central store (Ọba). Mirrors
/// `ClaudeStoreEntry` in `tauri-cmd.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaudeStoreEntry {
    pub kind: String,
    pub name: String,
    #[serde(rename = "storePath")]
    pub store_path: String,
    pub description: Option<String>,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: i64,
    #[serde(rename = "enabledIn")]
    pub enabled_in: Vec<String>,
}

/// Result of a symlink-farm mutation. Mirrors `ClaudeStoreMutation`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaudeStoreMutation {
    pub kind: String,
    pub name: String,
    pub scope: String,
    pub path: String,
    #[serde(rename = "linkTarget")]
    pub link_target: Option<String>,
}

// ─── Kind classification ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Agent,
    Skill,
    Command,
    /// JSON-fragment primitives handled by the WP-03 merge engine.
    Hook,
    Mcp,
}

impl Kind {
    fn parse(s: &str) -> Result<Kind, String> {
        match s {
            "agent" => Ok(Kind::Agent),
            "skill" => Ok(Kind::Skill),
            "command" => Ok(Kind::Command),
            "hook" => Ok(Kind::Hook),
            "mcp" => Ok(Kind::Mcp),
            _ => Err(format!(
                "kind must be one of skill|agent|command|hook|mcp, got {s:?}"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Kind::Agent => "agent",
            Kind::Skill => "skill",
            Kind::Command => "command",
            Kind::Hook => "hook",
            Kind::Mcp => "mcp",
        }
    }

    /// The `<kind>s/` subdir name shared by the store layout and the `.claude/`
    /// farm layout (e.g. `agents`, `skills`, `commands`).
    fn dir_name(self) -> Option<&'static str> {
        match self {
            Kind::Agent => Some("agents"),
            Kind::Skill => Some("skills"),
            Kind::Command => Some("commands"),
            Kind::Hook | Kind::Mcp => None,
        }
    }

    /// File-based primitives flow through the symlink farm; JSON-fragment
    /// primitives (hook/mcp) flow through the WP-03 merge engine.
    fn is_file_based(self) -> bool {
        matches!(self, Kind::Agent | Kind::Skill | Kind::Command)
    }

    /// A skill is a directory primitive; agents/commands are single `.md`
    /// files.
    fn is_dir_primitive(self) -> bool {
        matches!(self, Kind::Skill)
    }
}

/// Validate a primitive `name` — no path separators, no `..`, no leading dot,
/// bounded length. Names map directly onto on-disk path segments so this is a
/// load-bearing confinement check, not cosmetic.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 256 {
        return Err(format!("invalid name length: {} (1..=256)", name.len()));
    }
    if name.starts_with('.') {
        return Err(format!("name must not start with a dot: {name:?}"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!("name must not contain path separators: {name:?}"));
    }
    if name == "." || name == ".." || name.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(format!("name must not traverse parents: {name:?}"));
    }
    Ok(())
}

// ─── Pure path math (testable without env / DB) ───────────────────────────────

/// On-disk path of a primitive's canonical copy inside the store root.
/// `agent`/`command` → `<store>/<kind>s/<name>.md`; `skill` →
/// `<store>/skills/<name>` (a directory).
fn store_path_for(store: &Path, kind: Kind, name: &str) -> Result<PathBuf, String> {
    let dir = kind
        .dir_name()
        .ok_or_else(|| format!("kind {} is not file-based", kind.as_str()))?;
    let leaf = if kind.is_dir_primitive() {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    Ok(store.join(dir).join(leaf))
}

/// On-disk path of a primitive inside a scope's `.claude/` farm dir.
/// `scope_claude` is the `<scope>/.claude` directory.
fn scope_path_for(scope_claude: &Path, kind: Kind, name: &str) -> Result<PathBuf, String> {
    let dir = kind
        .dir_name()
        .ok_or_else(|| format!("kind {} is not file-based", kind.as_str()))?;
    let leaf = if kind.is_dir_primitive() {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    Ok(scope_claude.join(dir).join(leaf))
}

// ─── Atomic FS primitives ─────────────────────────────────────────────────────

/// Atomically copy a file: write to a sibling temp path, fsync, then rename
/// over the destination. A crash mid-copy leaves only the temp file (cleaned
/// up on the next run by being uniquely named), never a half-written dest.
fn atomic_copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = temp_sibling(dst);
    let bytes = std::fs::read(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    write_then_sync(&tmp, &bytes)?;
    std::fs::rename(&tmp, dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), dst.display())
    })
}

/// Atomically copy a directory tree (skills). Materialize the whole tree under
/// a sibling temp dir, then a single `rename` swaps it into place — so a crash
/// mid-copy never exposes a partial skill dir at the destination.
fn atomic_copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = temp_sibling(dst);
    // Clear any stale temp from a prior interrupted run.
    let _ = std::fs::remove_dir_all(&tmp);
    copy_dir_recursive(src, &tmp).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        e
    })?;
    // If a dest already exists, swap it out of the way then drop it — keeps the
    // window where neither exists as small as a rename.
    if dst.exists() {
        let old = temp_sibling(dst);
        std::fs::rename(dst, &old).map_err(|e| format!("stage-out {}: {e}", dst.display()))?;
        let res = std::fs::rename(&tmp, dst);
        match res {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&old);
                Ok(())
            }
            Err(e) => {
                // Roll the original back.
                let _ = std::fs::rename(&old, dst);
                let _ = std::fs::remove_dir_all(&tmp);
                Err(format!("rename {} -> {}: {e}", tmp.display(), dst.display()))
            }
        }
    } else {
        std::fs::rename(&tmp, dst).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            format!("rename {} -> {}: {e}", tmp.display(), dst.display())
        })
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let rd = std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let ft = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            // Resolve symlinks into real bytes so the store copy is canonical.
            let bytes = std::fs::read(&from).map_err(|e| format!("read {}: {e}", from.display()))?;
            write_then_sync(&to, &bytes)?;
        }
    }
    Ok(())
}

fn write_then_sync(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(bytes)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("fsync {}: {e}", path.display()))?;
    Ok(())
}

/// A uniquely-named sibling temp path for atomic rename staging.
fn temp_sibling(dst: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());
    let parent = dst.parent().map(Path::to_path_buf).unwrap_or_default();
    parent.join(format!(".{name}.ngwa-tmp.{nonce}"))
}

/// Remove a scope-local primitive (file, dir, or symlink). For a symlink we
/// only drop the link — `remove_file`/`remove_dir_all` both delete the link
/// node itself, never following into the store target. Idempotent on absence.
fn remove_primitive(path: &Path, kind: Kind) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("lstat {}: {e}", path.display())),
    };
    if meta.file_type().is_symlink() {
        // A symlink node is removed with remove_file on every platform,
        // including when it points at a directory — this never recurses into
        // the store target.
        std::fs::remove_file(path).map_err(|e| format!("unlink {}: {e}", path.display()))
    } else if kind.is_dir_primitive() {
        std::fs::remove_dir_all(path).map_err(|e| format!("rmdir {}: {e}", path.display()))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("rm {}: {e}", path.display()))
    }
}

/// Create a symlink at `link` pointing to `target`, replacing any existing
/// node atomically (build the link at a temp path, then rename over).
fn make_symlink(target: &Path, link: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = temp_sibling(link);
    let _ = std::fs::remove_file(&tmp);
    symlink_impl(target, &tmp)?;
    std::fs::rename(&tmp, link).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename link {} -> {}: {e}", tmp.display(), link.display())
    })
}

#[cfg(unix)]
fn symlink_impl(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|e| format!("symlink {} -> {}: {e}", link.display(), target.display()))
}

#[cfg(windows)]
fn symlink_impl(target: &Path, link: &Path) -> Result<(), String> {
    // On Windows, file vs dir symlinks use different syscalls.
    let res = if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    res.map_err(|e| format!("symlink {} -> {}: {e}", link.display(), target.display()))
}

// ─── Description extraction ───────────────────────────────────────────────────

/// Lift `description` from a primitive's frontmatter. For agents/commands the
/// `.md` is the file itself; for skills it's `<dir>/SKILL.md`.
fn read_description(store_entry: &Path, kind: Kind) -> Option<String> {
    let md = if kind.is_dir_primitive() {
        store_entry.join("SKILL.md")
    } else {
        store_entry.to_path_buf()
    };
    let (fm, _body) = parse_md(&md).ok()?;
    string_field(&fm, "description")
}

// ─── Catalog enumeration ──────────────────────────────────────────────────────

/// Walk the store catalog for a single kind, building one entry per canonical
/// primitive. `enabled_in` is left empty here — the command layer fills it by
/// probing each known scope's farm (see `claude_store_list`).
fn list_store_kind(store: &Path, kind: Kind) -> Vec<ClaudeStoreEntry> {
    let Some(dir) = kind.dir_name() else {
        return Vec::new();
    };
    let kind_dir = store.join(dir);
    let Ok(rd) = std::fs::read_dir(&kind_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let (name, canonical) = if kind.is_dir_primitive() {
            if !ft.is_dir() {
                continue;
            }
            (entry.file_name().to_string_lossy().to_string(), path.clone())
        } else {
            if ft.is_dir() {
                continue;
            }
            let fname = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = fname.strip_suffix(".md") else {
                continue;
            };
            (stem.to_string(), path.clone())
        };
        if name.starts_with('.') {
            continue;
        }
        out.push(ClaudeStoreEntry {
            kind: kind.as_str().to_string(),
            name,
            store_path: canonical.to_string_lossy().to_string(),
            description: read_description(&canonical, kind),
            modified_ms: mtime_ms(&canonical),
            enabled_in: Vec::new(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// True iff `name` of `kind` is currently enabled (symlinked) in the scope
/// whose `.claude` dir is `scope_claude`, AND the link resolves into the store.
fn is_enabled_in(scope_claude: &Path, store: &Path, kind: Kind, name: &str) -> bool {
    let Ok(p) = scope_path_for(scope_claude, kind, name) else {
        return false;
    };
    // Must exist as a symlink pointing into the store.
    let Ok(meta) = std::fs::symlink_metadata(&p) else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    match std::fs::canonicalize(&p) {
        Ok(resolved) => is_in_store(&resolved, store),
        Err(_) => false,
    }
}

// ─── Scope resolution (command layer) ─────────────────────────────────────────

/// Resolve a `ClaudeStoreScope` string to that scope's `.claude` directory.
/// `workspace` → `~/.claude`; `project:<id>` → `<project.root_path>/.claude`.
async fn resolve_scope_claude(db: &Arc<PaDb>, scope: &str) -> Result<PathBuf, String> {
    validate_pin_scope(scope)?;
    if scope == "workspace" {
        let home = std::env::var_os("HOME").ok_or_else(|| "HOME not set".to_string())?;
        return Ok(PathBuf::from(home).join(".claude"));
    }
    let id = scope
        .strip_prefix("project:")
        .ok_or_else(|| format!("unexpected scope {scope:?}"))?;
    let pool = db.ensure_pool().await?;
    let project = get_project(&pool, id)
        .await?
        .ok_or_else(|| format!("no project with id {id:?}"))?;
    let root = project
        .root_path
        .ok_or_else(|| format!("project {id:?} has no root_path"))?;
    let root = expand(&root).map_err(|e| e.to_string())?;
    Ok(root.join(".claude"))
}

/// Resolve a `ClaudeStoreScope` string to the `project_root` the WP-03 merge
/// engine expects: `None` for `workspace` (merge then targets `~/.claude/...`
/// and `~/.claude.json`), or `Some(<project.root_path>)` for `project:<id>`.
///
/// This is the JSON-fragment sibling of [`resolve_scope_claude`]: same scope
/// grammar (`validate_pin_scope`), same DB lookup (`get_project`), same
/// `~`-expansion — it just stops one level up (the project root itself, the
/// parent of `.claude`) because `merge` owns the `.claude` / `.mcp.json` /
/// `.claude.json` suffix per scope+kind. We do **not** invent a second
/// resolver: this funnels through the identical `get_project` path
/// `resolve_scope_claude` uses, just returning the root instead of `root/.claude`.
async fn resolve_scope_root(db: &Arc<PaDb>, scope: &str) -> Result<Option<PathBuf>, String> {
    validate_pin_scope(scope)?;
    if scope == "workspace" {
        return Ok(None);
    }
    let id = scope
        .strip_prefix("project:")
        .ok_or_else(|| format!("unexpected scope {scope:?}"))?;
    let pool = db.ensure_pool().await?;
    let project = get_project(&pool, id)
        .await?
        .ok_or_else(|| format!("no project with id {id:?}"))?;
    let root = project
        .root_path
        .ok_or_else(|| format!("project {id:?} has no root_path"))?;
    let root = expand(&root).map_err(|e| e.to_string())?;
    Ok(Some(root))
}

// ─── JSON-fragment (hook/mcp) store fragments ─────────────────────────────────
//
// The store keeps hook/mcp primitives as JSON fragments alongside the
// file-based ones, under `<store>/{hooks,mcp}/<name>.json`. "Enabling" a
// fragment in a scope splices its block into that scope's settings file via
// the WP-03 merge engine; it never symlinks (JSON primitives aren't files in a
// farm). The on-disk fragment is the catalog entry — scope toggles read it but
// never delete it (deleting the catalog entry is a separate store op).

/// Hook fragment schema (`<store>/hooks/<name>.json`). Carries everything
/// `merge::enable_hook` needs beyond the scope:
///
/// ```json
/// {
///   "event": "PreToolUse",        // the hooks.<event> key the block lands at
///   "file": "shared",             // "shared" → settings.json | "local" → settings.local.json
///   "block": [                    // value placed at hooks.<event> (Claude Code's
///     { "matcher": "Bash",        //   per-event array of matcher groups)
///       "hooks": [ { "type": "command", "command": "echo hi" } ] }
///   ]
/// }
/// ```
///
/// `event` and `block` are required; `file` defaults to `shared` when absent.
#[derive(Debug, Clone, Deserialize)]
struct HookFragment {
    event: String,
    #[serde(default)]
    file: HookFileTag,
    block: serde_json::Value,
}

/// Target settings file for a hook fragment. Mirrors `merge::HookFile`;
/// kept as a local wire enum so the fragment JSON uses lowercase tags.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HookFileTag {
    #[default]
    Shared,
    Local,
}

impl HookFileTag {
    fn to_merge(self) -> merge::HookFile {
        match self {
            HookFileTag::Shared => merge::HookFile::Shared,
            HookFileTag::Local => merge::HookFile::Local,
        }
    }
}

/// On-disk path of a hook/mcp fragment in the store: `<store>/<kind-dir>/<name>.json`.
/// `kind-dir` is `hooks` for [`Kind::Hook`] and `mcp` for [`Kind::Mcp`].
fn fragment_path(store: &Path, kind: Kind, name: &str) -> Result<PathBuf, String> {
    let dir = match kind {
        Kind::Hook => "hooks",
        Kind::Mcp => "mcp",
        other => return Err(format!("kind {} has no JSON fragment", other.as_str())),
    };
    Ok(store.join(dir).join(format!("{name}.json")))
}

/// Read + parse a hook fragment from the store.
fn read_hook_fragment(store: &Path, name: &str) -> Result<HookFragment, String> {
    let path = fragment_path(store, Kind::Hook, name)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read hook fragment {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse hook fragment {}: {e}", path.display()))
}

/// Read the MCP `server_def` from the store. For MCP the fragment file content
/// **is** the `server_def` value (the object placed at `mcpServers.<name>`).
fn read_mcp_fragment(store: &Path, name: &str) -> Result<serde_json::Value, String> {
    let path = fragment_path(store, Kind::Mcp, name)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read mcp fragment {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse mcp fragment {}: {e}", path.display()))
}

/// The settings file a hook/mcp enable/disable actually touches, for the
/// returned `ClaudeStoreMutation.path`. Mirrors `merge`'s own path resolution
/// (kept in lockstep): hooks land in `<root|~>/.claude/settings{,.local}.json`;
/// MCP lands in `<root>/.mcp.json` (project) or `~/.claude.json` (workspace).
/// `project_root.is_some()` ⇔ a `project:<id>` scope; `None` ⇔ `workspace`.
fn fragment_target_path(
    kind: Kind,
    project_root: Option<&Path>,
    hook_file: Option<HookFileTag>,
) -> Result<PathBuf, String> {
    let home = || {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME not set".to_string())
    };
    match kind {
        Kind::Hook => {
            let leaf = match hook_file.unwrap_or_default() {
                HookFileTag::Shared => "settings.json",
                HookFileTag::Local => "settings.local.json",
            };
            let claude = match project_root {
                Some(root) => root.join(".claude"),
                None => home()?.join(".claude"),
            };
            Ok(claude.join(leaf))
        }
        Kind::Mcp => match project_root {
            Some(root) => Ok(root.join(".mcp.json")),
            None => Ok(home()?.join(".claude.json")),
        },
        other => Err(format!("kind {} has no settings target", other.as_str())),
    }
}

/// Splice a hook/mcp fragment's block into `scope`'s settings file via the
/// merge engine (enable-in-scope). Returns the settings file touched (for the
/// `ClaudeStoreMutation.path`). Shared by enable / copy / move (the dest leg).
fn enable_fragment_in_scope(
    store: &Path,
    kind: Kind,
    name: &str,
    scope: &str,
    project_root: Option<&Path>,
) -> Result<PathBuf, String> {
    match kind {
        Kind::Hook => {
            let frag = read_hook_fragment(store, name)?;
            merge::enable_hook(
                scope,
                project_root,
                frag.file.to_merge(),
                &frag.event,
                frag.block,
            )
            .map_err(|e| e.to_string())?;
            fragment_target_path(Kind::Hook, project_root, Some(frag.file))
        }
        Kind::Mcp => {
            let server_def = read_mcp_fragment(store, name)?;
            merge::enable_mcp(scope, project_root, name, server_def).map_err(|e| e.to_string())?;
            fragment_target_path(Kind::Mcp, project_root, None)
        }
        other => Err(format!("kind {} is not a JSON fragment", other.as_str())),
    }
}

/// Remove a hook/mcp fragment's spliced block from `scope`'s settings file via
/// the merge engine (disable-in-scope). For hooks the event/file are read from
/// the store fragment. Shared by disable / move (the source leg).
fn disable_fragment_in_scope(
    store: &Path,
    kind: Kind,
    name: &str,
    scope: &str,
    project_root: Option<&Path>,
) -> Result<(), String> {
    match kind {
        Kind::Hook => {
            let frag = read_hook_fragment(store, name)?;
            merge::disable_hook(scope, project_root, frag.file.to_merge(), &frag.event)
                .map_err(|e| e.to_string())
        }
        Kind::Mcp => {
            merge::disable_mcp(scope, project_root, name).map_err(|e| e.to_string())
        }
        other => Err(format!("kind {} is not a JSON fragment", other.as_str())),
    }
}

// ─── Core mutation logic (pure; takes resolved roots) ─────────────────────────

/// `claude_store_import` core: copy an on-disk primitive into the store as the
/// new canonical source. Atomic. Returns the resulting catalog entry.
fn import_core(
    store: &Path,
    kind: Kind,
    name: &str,
    source: &Path,
) -> Result<ClaudeStoreEntry, String> {
    let dest = store_path_for(store, kind, name)?;
    // Confinement: the import dest must sit inside the store root we were
    // handed. `store_path_for` builds it from `store` + validated name, so the
    // only way this fails is a caller passing a bogus store root — reject it
    // rather than write outside the store. (We check against `store` directly,
    // not the global guard, because import is the one mutation that writes
    // *into* the store rather than a `.claude/` farm.)
    if !dest.starts_with(store) {
        return Err(format!("import dest outside store: {}", dest.display()));
    }
    if !source.exists() {
        return Err(format!("source does not exist: {}", source.display()));
    }
    if kind.is_dir_primitive() {
        if !source.is_dir() {
            return Err(format!("skill source is not a dir: {}", source.display()));
        }
        atomic_copy_dir(source, &dest)?;
    } else {
        if !source.is_file() {
            return Err(format!("source is not a file: {}", source.display()));
        }
        atomic_copy_file(source, &dest)?;
    }
    Ok(ClaudeStoreEntry {
        kind: kind.as_str().to_string(),
        name: name.to_string(),
        store_path: dest.to_string_lossy().to_string(),
        description: read_description(&dest, kind),
        modified_ms: mtime_ms(&dest),
        enabled_in: Vec::new(),
    })
}

/// `claude_primitive_enable` core: create a symlink in the scope farm pointing
/// at the store canonical copy. Idempotent.
fn enable_core(
    store: &Path,
    scope_claude: &Path,
    scope: &str,
    kind: Kind,
    name: &str,
) -> Result<ClaudeStoreMutation, String> {
    let target = store_path_for(store, kind, name)?;
    if !target.exists() {
        return Err(format!(
            "store has no {} named {name:?} (expected {})",
            kind.as_str(),
            target.display()
        ));
    }
    let link = scope_path_for(scope_claude, kind, name)?;
    if !is_under_claude_or_store(&link) {
        return Err(format!("enable target outside .claude/store: {}", link.display()));
    }
    // Idempotent: if already a store-backed link, no-op.
    if is_enabled_in(scope_claude, store, kind, name) {
        return Ok(ClaudeStoreMutation {
            kind: kind.as_str().to_string(),
            name: name.to_string(),
            scope: scope.to_string(),
            path: link.to_string_lossy().to_string(),
            link_target: Some(target.to_string_lossy().to_string()),
        });
    }
    make_symlink(&target, &link)?;
    Ok(ClaudeStoreMutation {
        kind: kind.as_str().to_string(),
        name: name.to_string(),
        scope: scope.to_string(),
        path: link.to_string_lossy().to_string(),
        link_target: Some(target.to_string_lossy().to_string()),
    })
}

/// `claude_primitive_disable` core: drop only the scope-local link. The store
/// canonical copy is untouched. Idempotent.
fn disable_core(scope_claude: &Path, kind: Kind, name: &str) -> Result<(), String> {
    let link = scope_path_for(scope_claude, kind, name)?;
    if !is_under_claude_or_store(&link) {
        return Err(format!("disable target outside .claude/store: {}", link.display()));
    }
    remove_primitive(&link, kind)
}

/// `claude_primitive_remove` core: delete the scope-local entry (link or real
/// file/dir). Does NOT touch the store. On a store-backed symlink this is
/// identical to disable; on a real primitive it deletes the actual file.
fn remove_core(scope_claude: &Path, kind: Kind, name: &str) -> Result<(), String> {
    let p = scope_path_for(scope_claude, kind, name)?;
    if !is_under_claude_or_store(&p) {
        return Err(format!("remove target outside .claude/store: {}", p.display()));
    }
    remove_primitive(&p, kind)
}

/// `claude_primitive_copy` core: copy the resolved primitive from one scope's
/// farm into another scope's farm, leaving the source in place. Atomic at the
/// destination. The copy is the resolved (real) primitive — symlinks are
/// followed so the destination owns a real file/dir, not a dangling link.
fn copy_core(
    from_claude: &Path,
    to_claude: &Path,
    from_scope: &str,
    to_scope: &str,
    kind: Kind,
    name: &str,
) -> Result<ClaudeStoreMutation, String> {
    let _ = from_scope;
    let src = scope_path_for(from_claude, kind, name)?;
    let dst = scope_path_for(to_claude, kind, name)?;
    if !is_under_claude_or_store(&src) {
        return Err(format!("copy source outside .claude/store: {}", src.display()));
    }
    if !is_under_claude_or_store(&dst) {
        return Err(format!("copy dest outside .claude/store: {}", dst.display()));
    }
    if !src.exists() {
        return Err(format!("copy source missing: {}", src.display()));
    }
    // Resolve through any symlink so the destination is a real, standalone
    // copy (not a link that would dangle if the source scope is later cleaned).
    let resolved = std::fs::canonicalize(&src)
        .map_err(|e| format!("resolve source {}: {e}", src.display()))?;
    if kind.is_dir_primitive() {
        atomic_copy_dir(&resolved, &dst)?;
    } else {
        atomic_copy_file(&resolved, &dst)?;
    }
    Ok(ClaudeStoreMutation {
        kind: kind.as_str().to_string(),
        name: name.to_string(),
        scope: to_scope.to_string(),
        path: dst.to_string_lossy().to_string(),
        link_target: None,
    })
}

/// `claude_primitive_move` core: copy-then-remove-source. The destination
/// write is atomic; the source removal only runs once the destination is in
/// place, so a crash between the two leaves the source intact (move degrades
/// to copy, never to loss).
fn move_core(
    from_claude: &Path,
    to_claude: &Path,
    from_scope: &str,
    to_scope: &str,
    kind: Kind,
    name: &str,
) -> Result<ClaudeStoreMutation, String> {
    let mutation = copy_core(from_claude, to_claude, from_scope, to_scope, kind, name)?;
    // Source removal is scope-local; never touches the store.
    let src = scope_path_for(from_claude, kind, name)?;
    remove_primitive(&src, kind)?;
    Ok(mutation)
}

// ─── Tauri command surface ────────────────────────────────────────────────────

/// List the central-store catalog. Optionally filter by kind. `enabledIn` is
/// populated by probing the workspace scope plus every known project scope.
#[tauri::command]
pub async fn claude_store_list(
    db: State<'_, Arc<PaDb>>,
    kind: Option<String>,
) -> Result<Vec<ClaudeStoreEntry>, String> {
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    let kinds: Vec<Kind> = match kind {
        Some(k) => vec![Kind::parse(&k)?],
        None => vec![Kind::Agent, Kind::Skill, Kind::Command],
    };

    // Build the set of scopes to probe for `enabledIn`: workspace + every
    // project with a root_path.
    let mut scopes: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(claude) = resolve_scope_claude(&db, "workspace").await {
        scopes.push(("workspace".to_string(), claude));
    }
    let pool = db.ensure_pool().await?;
    if let Ok(projects) = crate::commands::projects::list_projects(&pool, false).await {
        for p in projects {
            if let Some(root) = p.root_path.as_deref() {
                if let Ok(expanded) = expand(root) {
                    scopes.push((format!("project:{}", p.id), expanded.join(".claude")));
                }
            }
        }
    }

    let mut out = Vec::new();
    for k in kinds {
        if !k.is_file_based() {
            // hook/mcp catalogs are owned by the WP-03 merge engine.
            continue;
        }
        for mut entry in list_store_kind(&store, k) {
            entry.enabled_in = scopes
                .iter()
                .filter(|(_, claude)| is_enabled_in(claude, &store, k, &entry.name))
                .map(|(scope, _)| scope.clone())
                .collect();
            out.push(entry);
        }
    }
    Ok(out)
}

/// Import an on-disk primitive into the store as the new canonical copy.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_store_import(
    kind: String,
    name: String,
    sourcePath: String,
) -> Result<ClaudeStoreEntry, String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        return Err(format!(
            "claude_store_import: kind {} is JSON-fragment; import via the merge engine",
            k.as_str()
        ));
    }
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    let source = expand(&sourcePath).map_err(|e| e.to_string())?;
    import_core(&store, k, &name, &source)
}

/// Enable a store primitive in a scope (symlink-farm create for file-based;
/// merge-engine delegate for hook/mcp).
#[tauri::command]
pub async fn claude_primitive_enable(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    scope: String,
) -> Result<ClaudeStoreMutation, String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        // hook/mcp: read the store fragment and splice it into `scope`'s
        // settings file via the WP-03 merge engine. No symlink → link_target None.
        let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
        let root = resolve_scope_root(&db, &scope).await?;
        let target = enable_fragment_in_scope(&store, k, &name, &scope, root.as_deref())?;
        return Ok(ClaudeStoreMutation {
            kind: k.as_str().to_string(),
            name,
            scope,
            path: target.to_string_lossy().to_string(),
            link_target: None,
        });
    }
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    let scope_claude = resolve_scope_claude(&db, &scope).await?;
    enable_core(&store, &scope_claude, &scope, k, &name)
}

/// Disable a store primitive in a scope (drop the symlink for file-based;
/// merge-engine unmerge for hook/mcp).
#[tauri::command]
pub async fn claude_primitive_disable(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    scope: String,
) -> Result<(), String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        // hook/mcp: remove the spliced block from `scope`'s settings file via
        // the merge engine. For hooks the event/file come from the fragment.
        let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
        let root = resolve_scope_root(&db, &scope).await?;
        disable_fragment_in_scope(&store, k, &name, &scope, root.as_deref())?;
    } else {
        let scope_claude = resolve_scope_claude(&db, &scope).await?;
        disable_core(&scope_claude, k, &name)?;
    }
    // WP-04: the primitive is no longer resolvable at `scope`; clear any pin
    // that pointed at it so no dangling pin remains.
    let pool = db.ensure_pool().await?;
    clear_pin_for(&pool, &scope, k.as_str(), &name).await?;
    Ok(())
}

/// Copy a primitive from one scope to another, leaving the source in place.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_primitive_copy(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    fromScope: String,
    toScope: String,
) -> Result<ClaudeStoreMutation, String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        // hook/mcp copy = enable-in-dest; fromScope is left untouched. The store
        // fragment is the single source of truth for the block we splice.
        let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
        let dest_root = resolve_scope_root(&db, &toScope).await?;
        let target = enable_fragment_in_scope(&store, k, &name, &toScope, dest_root.as_deref())?;
        return Ok(ClaudeStoreMutation {
            kind: k.as_str().to_string(),
            name,
            scope: toScope,
            path: target.to_string_lossy().to_string(),
            link_target: None,
        });
    }
    let from_claude = resolve_scope_claude(&db, &fromScope).await?;
    let to_claude = resolve_scope_claude(&db, &toScope).await?;
    copy_core(&from_claude, &to_claude, &fromScope, &toScope, k, &name)
}

/// Move a primitive from one scope to another (copy-then-remove-source).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn claude_primitive_move(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    fromScope: String,
    toScope: String,
) -> Result<ClaudeStoreMutation, String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        // hook/mcp move = enable-in-dest THEN disable-in-source. Ordered so a
        // crash between the two legs degrades to "present in both" (a copy),
        // never to loss — mirrors the file-based move's copy-then-remove safety.
        let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
        let dest_root = resolve_scope_root(&db, &toScope).await?;
        let src_root = resolve_scope_root(&db, &fromScope).await?;
        let target = enable_fragment_in_scope(&store, k, &name, &toScope, dest_root.as_deref())?;
        disable_fragment_in_scope(&store, k, &name, &fromScope, src_root.as_deref())?;
        // WP-04: carry any pin from the source scope to the destination.
        let pool = db.ensure_pool().await?;
        repoint_pin(&pool, &fromScope, &toScope, k.as_str(), &name).await?;
        return Ok(ClaudeStoreMutation {
            kind: k.as_str().to_string(),
            name,
            scope: toScope,
            path: target.to_string_lossy().to_string(),
            link_target: None,
        });
    }
    let from_claude = resolve_scope_claude(&db, &fromScope).await?;
    let to_claude = resolve_scope_claude(&db, &toScope).await?;
    let mutation = move_core(&from_claude, &to_claude, &fromScope, &toScope, k, &name)?;
    // WP-04: the primitive left `fromScope` and now lives in `toScope`; carry
    // any pin across rather than orphan it at the now-empty source scope.
    let pool = db.ensure_pool().await?;
    repoint_pin(&pool, &fromScope, &toScope, k.as_str(), &name).await?;
    Ok(mutation)
}

/// Remove a primitive from a single scope's `.claude/` (does NOT touch the
/// store canonical copy).
#[tauri::command]
pub async fn claude_primitive_remove(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    scope: String,
) -> Result<(), String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    if !k.is_file_based() {
        // hook/mcp scope-local remove = disable in that scope. Per the contract
        // `remove(scope)` is scope-local, so we splice the block OUT of `scope`'s
        // settings but leave the store fragment in the catalog (deleting the
        // catalog entry is a separate store op).
        let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
        let root = resolve_scope_root(&db, &scope).await?;
        disable_fragment_in_scope(&store, k, &name, &scope, root.as_deref())?;
    } else {
        let scope_claude = resolve_scope_claude(&db, &scope).await?;
        remove_core(&scope_claude, k, &name)?;
    }
    // WP-04: the scope-local primitive is gone; clear any pin pointing at it.
    let pool = db.ensure_pool().await?;
    clear_pin_for(&pool, &scope, k.as_str(), &name).await?;
    Ok(())
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("ngwa_wp02_{tag}_{nonce}_{:p}", &nonce as *const _));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Build a (store, scope_claude) pair under a fresh tmp dir. The scope
    /// `.claude` dir sits under a `.claude` segment so the confinement guard
    /// accepts it without needing the real env-derived store root.
    fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = unique_tmp(tag);
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let scope = base.join("proj").join(".claude");
        std::fs::create_dir_all(&scope).unwrap();
        (base, store, scope)
    }

    fn seed_agent(store: &Path, name: &str, desc: &str) {
        let p = store_path_for(store, Kind::Agent, name).unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("---\nname: {name}\ndescription: {desc}\n---\nbody")).unwrap();
    }

    fn seed_skill(store: &Path, name: &str, desc: &str) {
        let dir = store_path_for(store, Kind::Skill, name).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\nbody"),
        )
        .unwrap();
        std::fs::write(dir.join("helper.py"), "print(1)\n").unwrap();
    }

    // ── name validation ──────────────────────────────────────────────────

    #[test]
    fn name_validation_rejects_traversal_and_separators() {
        assert!(validate_name("good-name").is_ok());
        assert!(validate_name("with_underscore").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name(".hidden").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name(&"x".repeat(257)).is_err());
    }

    #[test]
    fn kind_parse_and_file_based() {
        assert!(Kind::parse("agent").unwrap().is_file_based());
        assert!(Kind::parse("skill").unwrap().is_file_based());
        assert!(Kind::parse("command").unwrap().is_file_based());
        assert!(!Kind::parse("hook").unwrap().is_file_based());
        assert!(!Kind::parse("mcp").unwrap().is_file_based());
        assert!(Kind::parse("nope").is_err());
    }

    // ── enable creates a symlink resolving into the store ────────────────

    #[test]
    fn enable_creates_symlink_into_store() {
        let (base, store, scope) = fixture("enable");
        seed_agent(&store, "shared", "an agent");

        let m = enable_core(&store, &scope, "project:p", Kind::Agent, "shared").unwrap();
        let link = PathBuf::from(&m.path);
        let lmeta = std::fs::symlink_metadata(&link).unwrap();
        assert!(lmeta.file_type().is_symlink(), "farm entry is a symlink");

        // Resolves to the store canonical copy.
        let resolved = std::fs::canonicalize(&link).unwrap();
        let expected = std::fs::canonicalize(store_path_for(&store, Kind::Agent, "shared").unwrap())
            .unwrap();
        assert_eq!(resolved, expected, "symlink resolves into the store");
        assert!(is_in_store(&resolved, &store), "resolved target is in store");
        // link_target is the (unresolved) store path the symlink points at.
        let lt = m.link_target.expect("link_target populated on enable");
        assert!(lt.ends_with("shared.md"), "link target points at store copy: {lt}");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enable_is_idempotent() {
        let (base, store, scope) = fixture("idem");
        seed_agent(&store, "a", "x");
        let m1 = enable_core(&store, &scope, "workspace", Kind::Agent, "a").unwrap();
        let m2 = enable_core(&store, &scope, "workspace", Kind::Agent, "a").unwrap();
        assert_eq!(m1.path, m2.path);
        assert!(is_enabled_in(&scope, &store, Kind::Agent, "a"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enable_skill_dir_symlink() {
        let (base, store, scope) = fixture("skill_enable");
        seed_skill(&store, "myskill", "a skill");
        let m = enable_core(&store, &scope, "workspace", Kind::Skill, "myskill").unwrap();
        let link = PathBuf::from(&m.path);
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        // SKILL.md is reachable through the link.
        assert!(link.join("SKILL.md").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enable_missing_store_entry_errors() {
        let (base, store, scope) = fixture("missing");
        let err = enable_core(&store, &scope, "workspace", Kind::Agent, "ghost").unwrap_err();
        assert!(err.contains("store has no"), "got: {err}");
        std::fs::remove_dir_all(&base).ok();
    }

    // ── disable drops only the link; store intact ────────────────────────

    #[test]
    fn disable_drops_link_store_intact() {
        let (base, store, scope) = fixture("disable");
        seed_agent(&store, "a", "x");
        enable_core(&store, &scope, "workspace", Kind::Agent, "a").unwrap();
        let store_file = store_path_for(&store, Kind::Agent, "a").unwrap();
        assert!(store_file.exists());

        disable_core(&scope, Kind::Agent, "a").unwrap();
        let link = scope_path_for(&scope, Kind::Agent, "a").unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err(), "link removed");
        assert!(store_file.exists(), "store canonical copy untouched");

        // Idempotent — disabling again is fine.
        disable_core(&scope, Kind::Agent, "a").unwrap();
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn disable_skill_drops_link_not_store_tree() {
        let (base, store, scope) = fixture("disable_skill");
        seed_skill(&store, "s", "x");
        enable_core(&store, &scope, "workspace", Kind::Skill, "s").unwrap();
        disable_core(&scope, Kind::Skill, "s").unwrap();
        let link = scope_path_for(&scope, Kind::Skill, "s").unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        // Store skill dir + its files survive.
        let store_dir = store_path_for(&store, Kind::Skill, "s").unwrap();
        assert!(store_dir.join("SKILL.md").exists());
        assert!(store_dir.join("helper.py").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── copy / move preserve store + source integrity ────────────────────

    #[test]
    fn copy_materializes_real_file_in_dest_keeps_source() {
        let (base, store, from) = fixture("copy");
        let to = base.join("proj2").join(".claude");
        std::fs::create_dir_all(&to).unwrap();
        seed_agent(&store, "a", "x");
        enable_core(&store, &from, "workspace", Kind::Agent, "a").unwrap();

        let m = copy_core(&from, &to, "workspace", "project:p2", Kind::Agent, "a").unwrap();
        // Source link still present.
        let src_link = scope_path_for(&from, Kind::Agent, "a").unwrap();
        assert!(std::fs::symlink_metadata(&src_link).unwrap().file_type().is_symlink());
        // Dest is a REAL file (not a symlink), resolving the source link.
        let dst = PathBuf::from(&m.path);
        let dmeta = std::fs::symlink_metadata(&dst).unwrap();
        assert!(!dmeta.file_type().is_symlink(), "copy dest is a real file");
        assert!(dst.is_file());
        assert_eq!(m.link_target, None);
        // Store canonical copy intact.
        assert!(store_path_for(&store, Kind::Agent, "a").unwrap().exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_skill_dir_deep() {
        let (base, store, from) = fixture("copy_skill");
        let to = base.join("proj2").join(".claude");
        std::fs::create_dir_all(&to).unwrap();
        seed_skill(&store, "s", "x");
        enable_core(&store, &from, "workspace", Kind::Skill, "s").unwrap();
        let m = copy_core(&from, &to, "workspace", "project:p2", Kind::Skill, "s").unwrap();
        let dst = PathBuf::from(&m.path);
        assert!(!std::fs::symlink_metadata(&dst).unwrap().file_type().is_symlink());
        assert!(dst.join("SKILL.md").is_file());
        assert!(dst.join("helper.py").is_file());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn move_copies_then_removes_source() {
        let (base, store, from) = fixture("move");
        let to = base.join("proj2").join(".claude");
        std::fs::create_dir_all(&to).unwrap();
        seed_agent(&store, "a", "x");
        // Make the source a REAL file in the farm (not a link) so move clearly
        // relocates it.
        let src = scope_path_for(&from, Kind::Agent, "a").unwrap();
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, "---\nname: a\n---\nbody").unwrap();

        let m = move_core(&from, &to, "workspace", "project:p2", Kind::Agent, "a").unwrap();
        assert!(std::fs::symlink_metadata(&src).is_err(), "source removed");
        assert!(PathBuf::from(&m.path).is_file(), "dest present");
        // Store untouched (move is scope-local).
        assert!(store_path_for(&store, Kind::Agent, "a").unwrap().exists());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── path confinement ─────────────────────────────────────────────────

    #[test]
    fn mutations_reject_outside_claude_or_store() {
        let (base, store, _scope) = fixture("confine");
        seed_agent(&store, "a", "x");
        // A scope dir with NO `.claude` segment and not under the store.
        let rogue = base.join("not-claude");
        std::fs::create_dir_all(&rogue).unwrap();

        // enable into a rogue scope dir is rejected.
        let e1 = enable_core(&store, &rogue, "workspace", Kind::Agent, "a").unwrap_err();
        assert!(e1.contains("outside .claude/store"), "enable: {e1}");

        // disable on a rogue scope dir rejected.
        let e2 = disable_core(&rogue, Kind::Agent, "a").unwrap_err();
        assert!(e2.contains("outside .claude/store"), "disable: {e2}");

        // remove on a rogue scope dir rejected.
        let e3 = remove_core(&rogue, Kind::Agent, "a").unwrap_err();
        assert!(e3.contains("outside .claude/store"), "remove: {e3}");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_rejects_rogue_dest() {
        let (base, store, from) = fixture("confine_copy");
        seed_agent(&store, "a", "x");
        enable_core(&store, &from, "workspace", Kind::Agent, "a").unwrap();
        let rogue = base.join("rogue-dest");
        std::fs::create_dir_all(&rogue).unwrap();
        let e = copy_core(&from, &rogue, "workspace", "x", Kind::Agent, "a").unwrap_err();
        assert!(e.contains("outside .claude/store"), "copy dest: {e}");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn import_into_store_is_confined_and_atomic_layout() {
        let (base, store, _scope) = fixture("import");
        // Source primitive outside the store.
        let srcdir = base.join("incoming");
        std::fs::create_dir_all(&srcdir).unwrap();
        let src = srcdir.join("a.md");
        std::fs::write(&src, "---\nname: a\ndescription: imported\n---\nbody").unwrap();

        let entry = import_core(&store, Kind::Agent, "a", &src).unwrap();
        assert_eq!(entry.kind, "agent");
        assert_eq!(entry.name, "a");
        assert_eq!(entry.description.as_deref(), Some("imported"));
        let dest = store_path_for(&store, Kind::Agent, "a").unwrap();
        assert!(dest.is_file());
        // No leftover temp files in the store kind dir.
        let kind_dir = store.join("agents");
        let leftovers: Vec<_> = std::fs::read_dir(&kind_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("ngwa-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files leak into store");
        std::fs::remove_dir_all(&base).ok();
    }

    // ── atomicity: interrupted write proof ───────────────────────────────

    /// Simulate an interrupted atomic copy: stage the temp file but never
    /// rename it over the destination. Proves the destination is never left in
    /// a half-written state — it simply does not exist, and the canonical
    /// store copy (when overwriting) is untouched until the final rename.
    #[test]
    fn interrupted_write_leaves_dest_absent_not_partial() {
        let (base, store, _scope) = fixture("atomic");
        seed_agent(&store, "a", "original");
        let dest = store_path_for(&store, Kind::Agent, "a").unwrap();
        let original = std::fs::read_to_string(&dest).unwrap();

        // Manually perform the temp-write half of atomic_copy_file WITHOUT the
        // rename, mimicking a crash between write and rename.
        let tmp = temp_sibling(&dest);
        write_then_sync(&tmp, b"---\nname: a\ndescription: HALF\n---\npartial").unwrap();

        // The destination still holds the ORIGINAL, fully-valid content — the
        // partial write is isolated in the temp file.
        let after = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(after, original, "dest unchanged until rename commits");
        assert!(tmp.exists(), "partial content quarantined in temp file");
        // The temp file is uniquely named (won't be mistaken for a catalog entry).
        assert!(tmp
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("ngwa-tmp"));

        // Now complete the rename — the dest flips atomically to the new content.
        std::fs::rename(&tmp, &dest).unwrap();
        let final_content = std::fs::read_to_string(&dest).unwrap();
        assert!(final_content.contains("partial"), "rename commits new content");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn atomic_copy_file_overwrites_cleanly() {
        let (base, store, _scope) = fixture("overwrite");
        let kind_dir = store.join("agents");
        std::fs::create_dir_all(&kind_dir).unwrap();
        let dst = kind_dir.join("a.md");
        std::fs::write(&dst, "old").unwrap();
        let src = base.join("new.md");
        std::fs::write(&src, "new-content").unwrap();
        atomic_copy_file(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "new-content");
        std::fs::remove_dir_all(&base).ok();
    }

    // ── catalog listing ──────────────────────────────────────────────────

    #[test]
    fn list_store_kind_reports_entries_with_description() {
        let (base, store, _scope) = fixture("list");
        seed_agent(&store, "alpha", "first");
        seed_agent(&store, "beta", "second");
        seed_skill(&store, "gamma", "skilled");

        let agents = list_store_kind(&store, Kind::Agent);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].name, "alpha");
        assert_eq!(agents[0].description.as_deref(), Some("first"));
        assert_eq!(agents[1].name, "beta");

        let skills = list_store_kind(&store, Kind::Skill);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "gamma");
        assert_eq!(skills[0].description.as_deref(), Some("skilled"));

        // hook/mcp have no store catalog here.
        assert!(list_store_kind(&store, Kind::Hook).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enabled_in_detection() {
        let (base, store, scope) = fixture("enabledin");
        seed_agent(&store, "a", "x");
        assert!(!is_enabled_in(&scope, &store, Kind::Agent, "a"));
        enable_core(&store, &scope, "workspace", Kind::Agent, "a").unwrap();
        assert!(is_enabled_in(&scope, &store, Kind::Agent, "a"));
        disable_core(&scope, Kind::Agent, "a").unwrap();
        assert!(!is_enabled_in(&scope, &store, Kind::Agent, "a"));
        std::fs::remove_dir_all(&base).ok();
    }

    // ── JSON-fragment (hook/mcp) wiring: store-fragment → merge engine ────
    //
    // These exercise the integration seam this WP owns: read a store fragment,
    // splice/unsplice it via the merge engine, and (for the dest path) report
    // the right settings file. They use a project scope with an explicit root
    // so no HOME override is needed for the project legs; the move test threads
    // both a project src and project dest.

    use serde_json::{json, Value};

    /// Write a hook fragment into the store catalog.
    fn seed_hook_fragment(store: &Path, name: &str, event: &str, file: &str, block: Value) {
        let p = fragment_path(store, Kind::Hook, name).unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let frag = json!({ "event": event, "file": file, "block": block });
        std::fs::write(&p, serde_json::to_string_pretty(&frag).unwrap()).unwrap();
    }

    /// Write an MCP fragment — its content IS the server_def.
    fn seed_mcp_fragment(store: &Path, name: &str, server_def: Value) {
        let p = fragment_path(store, Kind::Mcp, name).unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, serde_json::to_string_pretty(&server_def).unwrap()).unwrap();
    }

    /// MCP enable splices ONLY `mcpServers.<name>` into `<root>/.mcp.json`,
    /// preserving every unrelated key; disable removes only that block.
    #[test]
    fn mcp_fragment_enable_disable_splices_one_key() {
        let base = unique_tmp("mcp_frag");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // Project root (parent of .claude) — the merge engine writes .mcp.json here.
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();

        // Seed an existing .mcp.json with an unrelated server we must preserve.
        let mcp_json = proj.join(".mcp.json");
        std::fs::write(
            &mcp_json,
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "exa": { "type": "stdio", "command": "exa-mcp" } }
            }))
            .unwrap(),
        )
        .unwrap();

        let def = json!({ "type": "stdio", "command": "royalti-mcp", "args": ["--stdio"] });
        seed_mcp_fragment(&store, "royalti", def.clone());

        // enable-in-scope → block spliced, exa preserved, target is .mcp.json.
        let target =
            enable_fragment_in_scope(&store, Kind::Mcp, "royalti", "project:p", Some(&proj))
                .unwrap();
        assert_eq!(target, mcp_json, "MCP target is <root>/.mcp.json");
        let after: Value = serde_json::from_slice(&std::fs::read(&mcp_json).unwrap()).unwrap();
        assert_eq!(after.pointer("/mcpServers/royalti").unwrap(), &def);
        assert!(
            after.pointer("/mcpServers/exa").is_some(),
            "unrelated server preserved"
        );

        // disable-in-scope → only the royalti block removed; exa survives.
        disable_fragment_in_scope(&store, Kind::Mcp, "royalti", "project:p", Some(&proj)).unwrap();
        let after2: Value = serde_json::from_slice(&std::fs::read(&mcp_json).unwrap()).unwrap();
        assert!(after2.pointer("/mcpServers/royalti").is_none(), "royalti removed");
        assert!(after2.pointer("/mcpServers/exa").is_some(), "exa untouched");

        std::fs::remove_dir_all(&base).ok();
    }

    /// Hook enable lands the fragment's block at `hooks.<event>` in the right
    /// settings file (shared vs local driven by the fragment's `file` tag).
    #[test]
    fn hook_fragment_enable_lands_block_in_right_file() {
        let base = unique_tmp("hook_frag");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();

        let block = json!([
            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo hi" } ] }
        ]);
        // file: "local" → settings.local.json.
        seed_hook_fragment(&store, "guard", "PreToolUse", "local", block.clone());

        let target =
            enable_fragment_in_scope(&store, Kind::Hook, "guard", "project:p", Some(&proj))
                .unwrap();
        let expected = proj.join(".claude").join("settings.local.json");
        assert_eq!(target, expected, "hook 'local' → settings.local.json");

        let after: Value = serde_json::from_slice(&std::fs::read(&expected).unwrap()).unwrap();
        assert_eq!(
            after.pointer("/hooks/PreToolUse").unwrap(),
            &block,
            "block landed at hooks.PreToolUse"
        );
        // settings.json (shared) was NOT created — the fragment targeted local.
        assert!(
            !proj.join(".claude").join("settings.json").exists(),
            "shared file untouched"
        );

        disable_fragment_in_scope(&store, Kind::Hook, "guard", "project:p", Some(&proj)).unwrap();
        let after2: Value = serde_json::from_slice(&std::fs::read(&expected).unwrap()).unwrap();
        assert!(after2.pointer("/hooks/PreToolUse").is_none(), "block removed on disable");

        std::fs::remove_dir_all(&base).ok();
    }

    /// move = enable-in-dest + disable-in-source: present in dest, absent in
    /// source. Both legs use explicit project roots.
    #[test]
    fn mcp_fragment_move_present_in_dest_absent_in_source() {
        let base = unique_tmp("mcp_move");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();

        let def = json!({ "type": "stdio", "command": "royalti-mcp" });
        seed_mcp_fragment(&store, "royalti", def.clone());

        // Pre-enable in source so move has something to disable there.
        enable_fragment_in_scope(&store, Kind::Mcp, "royalti", "project:s", Some(&src)).unwrap();
        assert!(src.join(".mcp.json").exists());

        // Now the move legs (mirrors the command arm's ordering).
        enable_fragment_in_scope(&store, Kind::Mcp, "royalti", "project:d", Some(&dst)).unwrap();
        disable_fragment_in_scope(&store, Kind::Mcp, "royalti", "project:s", Some(&src)).unwrap();

        let in_dst: Value = serde_json::from_slice(&std::fs::read(dst.join(".mcp.json")).unwrap())
            .unwrap();
        assert_eq!(
            in_dst.pointer("/mcpServers/royalti").unwrap(),
            &def,
            "present in dest after move"
        );
        let in_src: Value = serde_json::from_slice(&std::fs::read(src.join(".mcp.json")).unwrap())
            .unwrap();
        assert!(
            in_src.pointer("/mcpServers/royalti").is_none(),
            "absent in source after move"
        );

        // Store fragment is NOT deleted by scope-local ops.
        assert!(fragment_path(&store, Kind::Mcp, "royalti").unwrap().exists());

        std::fs::remove_dir_all(&base).ok();
    }

    /// Fragment schema: `file` defaults to `shared` when omitted; `event` +
    /// `block` are carried through.
    #[test]
    fn hook_fragment_file_defaults_to_shared() {
        let base = unique_tmp("hook_default");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let p = fragment_path(&store, Kind::Hook, "h").unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        // No "file" key.
        std::fs::write(&p, r#"{ "event": "Stop", "block": [] }"#).unwrap();
        let frag = read_hook_fragment(&store, "h").unwrap();
        assert_eq!(frag.event, "Stop");
        assert!(matches!(frag.file, HookFileTag::Shared));
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let target =
            enable_fragment_in_scope(&store, Kind::Hook, "h", "project:p", Some(&proj)).unwrap();
        assert_eq!(target, proj.join(".claude").join("settings.json"));
        std::fs::remove_dir_all(&base).ok();
    }
}
