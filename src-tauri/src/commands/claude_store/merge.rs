//! Settings-JSON merge engine (WP-03) — pure library for splicing a single
//! keyed JSON block into / out of Claude Code's config files while preserving
//! every unrelated key.
//!
//! Two block families:
//!   - **hooks**     → live under the top-level `hooks` object in
//!                     `settings.json` / `settings.local.json`. The block key
//!                     is the hook *event* name (e.g. `PreToolUse`); the value
//!                     is the per-event array of matcher groups Claude Code
//!                     expects.
//!   - **mcpServers** → live under the top-level `mcpServers` object in
//!                     `<root>/.mcp.json` (project scope) or `~/.claude.json`
//!                     (user scope). The block key is the server name.
//!
//! Mechanic (every mutation): **read whole object → splice the single child
//! key under the fixed parent key → serialize → temp-file in the same dir →
//! atomic rename.** Every unrelated top-level key is carried through the
//! `serde_json::Map` untouched, so its content is byte-preserved. (`serde_json`
//! is compiled without `preserve_order` in this crate, so the map is a
//! `BTreeMap`: serialization is deterministic and a round-trip
//! enable→disable returns the file to byte-identical state.)
//!
//! **`~/.claude.json` is never rewritten wholesale** beyond this read→splice
//! `mcpServers`→write cycle — its OAuth / session keys are read in, left
//! untouched in the map, and written back verbatim. We only ever mutate the
//! `mcpServers` key.
//!
//! Pure functions only — no Tauri commands, no shared state. The store layer
//! (WP-02, `claude_store.rs`) resolves a `scope` string to a concrete project
//! `root_path` (an async DB lookup it owns) and calls these with the resolved
//! directory; this module stays synchronous and side-effect-bounded to the
//! one target file.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};

/// Which on-disk settings file a hook block lands in. Mirrors the two project
/// settings files Claude Code reads (`settings.local.json` shadows
/// `settings.json`); user-scope hooks land in `~/.claude/settings.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookFile {
    /// `settings.json` (shared / committed).
    Shared,
    /// `settings.local.json` (machine-local, git-ignored).
    Local,
}

// ─── Scope grammar ──────────────────────────────────────────────────────────
//
// Reuses the pin layer's grammar: `'workspace' | 'project:<id>'`. Kept as a
// local copy because the canonical `validate_pin_scope` in `claude_config.rs`
// is private; the grammar is frozen by the G-CONTRACT so duplicating it here
// is safe and keeps this module dependency-light. The orchestrator may swap
// this for a shared import at integration with no behavioural change.

/// Validate a scope string against the frozen grammar `workspace |
/// project:<id>` and return the resolved kind. `<id>` must be a non-empty,
/// ≤64-char `[a-z0-9][a-z0-9_-]*`.
pub fn validate_scope(scope: &str) -> Result<ScopeKind> {
    if scope == "workspace" {
        return Ok(ScopeKind::Workspace);
    }
    if let Some(id) = scope.strip_prefix("project:") {
        if id.is_empty() || id.len() > 64 {
            return Err(anyhow!("invalid project id length in scope {scope:?}"));
        }
        let mut chars = id.chars();
        let first = chars.next().unwrap();
        if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
            return Err(anyhow!("invalid project id in scope {scope:?}"));
        }
        for c in chars {
            if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                return Err(anyhow!("invalid project id in scope {scope:?}"));
            }
        }
        return Ok(ScopeKind::Project(id.to_string()));
    }
    Err(anyhow!(
        "scope must be 'workspace' or 'project:<id>', got {scope:?}"
    ))
}

/// Resolved scope kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeKind {
    /// User / workspace-wide scope — targets `~/.claude/...` and `~/.claude.json`.
    Workspace,
    /// A specific project by id — targets files under the project's `root_path`.
    Project(String),
}

// ─── Public API — hooks ──────────────────────────────────────────────────────

/// Enable (add or overwrite) a hook block keyed by `event` in the settings
/// file for `scope`. `project_root` is the project's resolved `root_path`,
/// required for `project:<id>` scopes and ignored for `workspace`. `block` is
/// the value placed at `hooks.<event>` (typically a JSON array of matcher
/// groups). All other keys in the file are preserved.
pub fn enable_hook(
    scope: &str,
    project_root: Option<&Path>,
    file: HookFile,
    event: &str,
    block: Value,
) -> Result<()> {
    let path = hook_path(scope, project_root, file)?;
    splice_nested(&path, "hooks", event, Some(block))
}

/// Disable (remove) the hook block keyed by `event` from the settings file for
/// `scope`. Removing the last hook leaves an empty `hooks: {}` object in place
/// (so the parent key's presence is stable); all other keys are preserved. A
/// missing file or missing key is a no-op.
pub fn disable_hook(
    scope: &str,
    project_root: Option<&Path>,
    file: HookFile,
    event: &str,
) -> Result<()> {
    let path = hook_path(scope, project_root, file)?;
    splice_nested(&path, "hooks", event, None)
}

// ─── Public API — mcpServers ──────────────────────────────────────────────────

/// Enable (add or overwrite) an MCP server definition keyed by `name`.
///   - `workspace` scope → `~/.claude.json` (only the `mcpServers` key is
///     touched; OAuth / session keys are preserved verbatim).
///   - `project:<id>` scope → `<root>/.mcp.json`.
/// `server_def` is the value placed at `mcpServers.<name>`.
pub fn enable_mcp(
    scope: &str,
    project_root: Option<&Path>,
    name: &str,
    server_def: Value,
) -> Result<()> {
    let path = mcp_path(scope, project_root)?;
    splice_nested(&path, "mcpServers", name, Some(server_def))
}

/// Disable (remove) the MCP server keyed by `name`. Removing the last server
/// leaves an empty `mcpServers: {}` object; every other key — crucially the
/// `~/.claude.json` session state — is preserved. A missing file or missing
/// key is a no-op.
pub fn disable_mcp(scope: &str, project_root: Option<&Path>, name: &str) -> Result<()> {
    let path = mcp_path(scope, project_root)?;
    splice_nested(&path, "mcpServers", name, None)
}

// ─── Path resolution ──────────────────────────────────────────────────────────

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME not set"))
}

/// `<dir>/.claude` for a project root, or `~/.claude` for workspace scope.
fn claude_dir(scope: &str, project_root: Option<&Path>) -> Result<PathBuf> {
    match validate_scope(scope)? {
        ScopeKind::Workspace => Ok(home_dir()?.join(".claude")),
        ScopeKind::Project(_) => {
            let root = project_root.ok_or_else(|| {
                anyhow!("project scope {scope:?} requires a resolved project_root")
            })?;
            Ok(root.join(".claude"))
        }
    }
}

fn hook_path(scope: &str, project_root: Option<&Path>, file: HookFile) -> Result<PathBuf> {
    let name = match file {
        HookFile::Shared => "settings.json",
        HookFile::Local => "settings.local.json",
    };
    Ok(claude_dir(scope, project_root)?.join(name))
}

fn mcp_path(scope: &str, project_root: Option<&Path>) -> Result<PathBuf> {
    match validate_scope(scope)? {
        // User-scope MCP servers live in the home `~/.claude.json` that Claude
        // Code actually reads (see registries/mcp.rs). NOT `~/.claude/...`.
        ScopeKind::Workspace => Ok(home_dir()?.join(".claude.json")),
        // Project-scope MCP servers live in `<root>/.mcp.json` (Claude Code's
        // canonical per-project MCP file).
        ScopeKind::Project(_) => {
            let root = project_root.ok_or_else(|| {
                anyhow!("project scope {scope:?} requires a resolved project_root")
            })?;
            Ok(root.join(".mcp.json"))
        }
    }
}

// ─── Core splice ──────────────────────────────────────────────────────────────

/// Read `path` as a JSON object, set or remove `parent_key.child_key`, then
/// atomically write it back. `value = Some(_)` inserts/overwrites; `None`
/// removes. All sibling keys (top-level and within `parent_key`) are carried
/// through untouched.
///
/// Removal of a missing file / parent / child is a no-op (no write, no error)
/// — important so a `disable_*` on a clean machine never materializes a file.
fn splice_nested(
    path: &Path,
    parent_key: &str,
    child_key: &str,
    value: Option<Value>,
) -> Result<()> {
    let removing = value.is_none();
    let existed = path.exists();

    // No-op fast paths for removal so we never create a file just to delete
    // from it.
    if removing && !existed {
        return Ok(());
    }

    let mut root = read_object(path)?;

    if removing {
        // Only descend if the parent object exists and holds the child.
        let removed = match root.get_mut(parent_key) {
            Some(Value::Object(inner)) => inner.remove(child_key).is_some(),
            _ => false,
        };
        if !removed {
            // Nothing to do — leave the file byte-identical by not rewriting.
            return Ok(());
        }
        write_object(path, &root)?;
        return Ok(());
    }

    // Insert / overwrite. Get-or-create the parent object; refuse to clobber a
    // non-object parent (a user/Claude-Code-set scalar there is load-bearing).
    let block = value.expect("checked Some above");
    let entry = root
        .entry(parent_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    match entry {
        Value::Object(inner) => {
            inner.insert(child_key.to_string(), block);
        }
        _ => {
            return Err(anyhow!(
                "{} `{parent_key}` is not an object — refusing to overwrite",
                path.display()
            ));
        }
    }
    write_object(path, &root)?;
    Ok(())
}

/// Read a JSON file into a root object. Missing / empty file → empty object so
/// first-write works on a clean machine. A non-object root is an error
/// (matches `read_settings` / `load_config` behaviour — refuse to overwrite).
fn read_object(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Map::new()),
        Ok(s) => {
            let v: Value =
                serde_json::from_str(&s).with_context(|| format!("parse {}", path.display()))?;
            match v {
                Value::Object(m) => Ok(m),
                other => Err(anyhow!(
                    "{} is not a JSON object (got {other:?}) — refusing to overwrite",
                    path.display()
                )),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(anyhow!("read {}: {e}", path.display())),
    }
}

/// Atomic write: serialize → temp file in the same dir → fsync-free rename.
/// Pretty-printed with a trailing newline to match the engine adapter's
/// `write_settings` output (byte equivalence across the two write sites).
fn write_object(path: &Path, root: &Map<String, Value>) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("settings path has no parent"))?;
    std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    let mut pretty = serde_json::to_string_pretty(&Value::Object(root.clone()))
        .map_err(|e| anyhow!("serialize claude settings: {e}"))?;
    pretty.push('\n');
    let tmp_name = format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "settings".to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    // ── Scope grammar (mirrors the pin layer's coverage) ──────────────────
    #[test]
    fn scope_grammar() {
        assert_eq!(validate_scope("workspace").unwrap(), ScopeKind::Workspace);
        assert_eq!(
            validate_scope("project:music-2026").unwrap(),
            ScopeKind::Project("music-2026".to_string())
        );
        assert!(validate_scope("personal").is_err());
        assert!(validate_scope("project:").is_err());
        assert!(validate_scope("project:BadCase").is_err());
        assert!(validate_scope("workspace:x").is_err());
    }

    /// A `settings.json` in the canonical write form this engine emits, with
    /// several unrelated keys we must never disturb.
    fn seed_settings(dir: &Path) -> PathBuf {
        let claude = dir.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let p = claude.join("settings.json");
        let initial = json!({
            "model": "claude-opus-4",
            "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
            "statusLine": { "type": "command", "command": "~/bin/sl" },
        });
        // Write through our own writer so the baseline is in canonical form
        // (sorted keys + pretty + trailing newline). The round-trip assertion
        // then proves enable→disable returns to *this* exact byte sequence.
        let m = match initial {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        write_object(&p, &m).unwrap();
        p
    }

    #[test]
    fn hook_round_trip_byte_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let p = seed_settings(root);
        let baseline = fs::read(&p).unwrap();
        let scope = "project:demo";

        let block = json!([
            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo hi" } ] }
        ]);
        enable_hook(scope, Some(root), HookFile::Shared, "PreToolUse", block).unwrap();

        let after_add: Value =
            serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        // Hook landed under hooks.PreToolUse.
        assert!(after_add
            .get("hooks")
            .and_then(|h| h.get("PreToolUse"))
            .is_some());
        // Unrelated keys untouched.
        assert_eq!(after_add.get("model").unwrap(), &json!("claude-opus-4"));
        assert_eq!(
            after_add.get("statusLine").unwrap(),
            &json!({ "type": "command", "command": "~/bin/sl" })
        );

        disable_hook(scope, Some(root), HookFile::Shared, "PreToolUse").unwrap();
        let after_remove = fs::read(&p).unwrap();

        // The only delta disable leaves is an empty `hooks: {}` object — assert
        // that explicitly, then prove every original key is byte-identical by
        // stripping the added empty parent and re-serializing.
        let mut v: Value = serde_json::from_slice(&after_remove).unwrap();
        assert_eq!(
            v.get("hooks").unwrap(),
            &json!({}),
            "removing the last hook leaves an empty hooks object"
        );
        if let Value::Object(m) = &mut v {
            m.remove("hooks");
        }
        let mut reser = serde_json::to_string_pretty(&v).unwrap();
        reser.push('\n');
        assert_eq!(
            reser.as_bytes(),
            baseline.as_slice(),
            "all unrelated keys byte-identical after enable→disable"
        );
    }

    #[test]
    fn project_mcp_round_trip_byte_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Seed a project `.mcp.json` in canonical form with one pre-existing
        // user server we must preserve.
        let p = root.join(".mcp.json");
        let seed = json!({
            "mcpServers": {
                "exa": { "type": "stdio", "command": "exa-mcp", "args": [] }
            }
        });
        let m = match seed {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        write_object(&p, &m).unwrap();
        let baseline = fs::read(&p).unwrap();
        let scope = "project:demo";

        let def = json!({ "type": "stdio", "command": "royalti-mcp", "args": ["--stdio"] });
        enable_mcp(scope, Some(root), "royalti", def).unwrap();

        let after_add: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        let servers = after_add.get("mcpServers").unwrap();
        assert!(servers.get("royalti").is_some());
        // Pre-existing server preserved verbatim.
        assert_eq!(
            servers.get("exa").unwrap(),
            &json!({ "type": "stdio", "command": "exa-mcp", "args": [] })
        );

        disable_mcp(scope, Some(root), "royalti").unwrap();
        let after_remove = fs::read(&p).unwrap();
        assert_eq!(
            after_remove, baseline,
            "project .mcp.json byte-identical after enable→disable (exa untouched)"
        );
    }

    /// The load-bearing safety property: a workspace-scope MCP enable/disable
    /// touches ONLY the `mcpServers` key of `~/.claude.json` and leaves OAuth /
    /// session state byte-identical. We point HOME at a temp dir so the test is
    /// hermetic and never touches the real `~/.claude.json`.
    #[test]
    fn user_claude_json_session_keys_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let claude_json = home.join(".claude.json");
        // Realistic shape: OAuth / session keys alongside an existing server.
        let seed = json!({
            "oauthAccount": { "accountUuid": "abc-123", "emailAddress": "x@y.z" },
            "mcpServers": {
                "pencil": { "type": "stdio", "command": "pencil", "args": [] }
            },
            "numStartups": 42,
            "userID": "user_xyz",
        });
        let m = match seed {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        write_object(&claude_json, &m).unwrap();
        let baseline = fs::read(&claude_json).unwrap();

        // Run enable+disable with HOME overridden. Env mutation is process-wide
        // — guard it for this single-threaded test path.
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home);

        let def = json!({ "type": "stdio", "command": "royalti-mcp", "args": [] });
        enable_mcp("workspace", None, "royalti", def).unwrap();

        let after_add: Value = serde_json::from_slice(&fs::read(&claude_json).unwrap()).unwrap();
        // Session keys still present & equal after the add.
        assert_eq!(
            after_add.get("oauthAccount").unwrap(),
            &json!({ "accountUuid": "abc-123", "emailAddress": "x@y.z" })
        );
        assert_eq!(after_add.get("numStartups").unwrap(), &json!(42));
        assert_eq!(after_add.get("userID").unwrap(), &json!("user_xyz"));
        // Our server landed; pencil preserved.
        let servers = after_add.get("mcpServers").unwrap();
        assert!(servers.get("royalti").is_some());
        assert!(servers.get("pencil").is_some());

        disable_mcp("workspace", None, "royalti").unwrap();
        let after_remove = fs::read(&claude_json).unwrap();

        // Restore HOME before any assertion can early-return.
        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(
            after_remove, baseline,
            "~/.claude.json byte-identical after enable→disable — only mcpServers was touched"
        );
    }

    #[test]
    fn disable_on_clean_machine_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // No files exist yet.
        disable_hook("project:demo", Some(root), HookFile::Local, "PreToolUse").unwrap();
        disable_mcp("project:demo", Some(root), "nope").unwrap();
        assert!(!root.join(".claude").join("settings.local.json").exists());
        assert!(!root.join(".mcp.json").exists());
    }

    #[test]
    fn project_scope_requires_root() {
        let block = json!([]);
        assert!(enable_hook("project:demo", None, HookFile::Shared, "E", block).is_err());
        assert!(enable_mcp("project:demo", None, "n", json!({})).is_err());
    }

    #[test]
    fn refuses_non_object_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let claude = root.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let p = claude.join("settings.json");
        // hooks is a scalar — engine must refuse rather than clobber.
        fs::write(&p, "{\"hooks\": \"oops\"}\n").unwrap();
        let err = enable_hook("project:demo", Some(root), HookFile::Shared, "E", json!([]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not an object"), "got: {err}");
    }
}
