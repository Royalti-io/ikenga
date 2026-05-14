//! Layered `.env` file loading for session + sidecar spawns.
//!
//! Phase 7 of projects-first-class. Resolves the user's `.env` files
//! into a key→value map for injection into spawned children. The
//! precedence (highest wins on conflict):
//!
//!   1. process env at app launch — already inherited via
//!      `Command::new()`. We don't redundantly inject those.
//!   2. workspace env at `<app_data_dir>/workspace.env`
//!   3. project's root `.env`
//!   4. project's root `.env.local`
//!
//! Pkg-supplied env (from manifest declarations) is layered on top by
//! the kernel's own spawn-prep code, not by this module.
//!
//! Format: dotenv-compatible. Supports:
//!   - `KEY=value` (unquoted; bare value, no trailing comments)
//!   - `KEY="value"` (double-quoted; `\"`, `\\`, `\$`, `` \` `` escapes)
//!   - `KEY='value'` (single-quoted; no escapes)
//!   - `# comment` lines (and lines that are entirely whitespace)
//!   - leading `export ` (POSIX shell convention; stripped)
//!
//! We never WRITE `.env` files. Editing secrets is the vault's job.

use std::collections::BTreeMap;
use std::path::Path;

/// Parse a `.env`-style file. Best-effort — malformed lines are skipped
/// with a warning rather than aborting. Returns an empty map if the
/// file doesn't exist.
pub fn parse_env_file(path: &Path) -> BTreeMap<String, String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    parse_env_string(&contents)
}

pub fn parse_env_string(contents: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (i, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((k, v)) = line.split_once('=') else {
            log::warn!("env_files: line {} skipped (no `=`)", i + 1);
            continue;
        };
        let key = k.trim().to_string();
        if key.is_empty() || !is_valid_env_key(&key) {
            log::warn!("env_files: line {} skipped (invalid key)", i + 1);
            continue;
        }
        let value = parse_value(v.trim());
        out.insert(key, value);
    }
    out
}

fn is_valid_env_key(s: &str) -> bool {
    let mut chars = s.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_value(raw: &str) -> String {
    let raw = raw.trim();
    if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
        // Double-quoted: handle backslash escapes.
        let inner = &raw[1..raw.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(&next) = chars.peek() {
                    match next {
                        '"' | '\\' | '$' | '`' | 'n' | 't' | 'r' => {
                            chars.next();
                            out.push(match next {
                                'n' => '\n',
                                't' => '\t',
                                'r' => '\r',
                                other => other,
                            });
                            continue;
                        }
                        _ => {}
                    }
                }
            }
            out.push(c);
        }
        out
    } else if raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2 {
        // Single-quoted: literal.
        raw[1..raw.len() - 1].to_string()
    } else {
        // Unquoted: strip trailing comment if any.
        if let Some(idx) = raw.find(" #") {
            raw[..idx].trim_end().to_string()
        } else {
            raw.to_string()
        }
    }
}

/// Compose the layered env for a spawn target.
///
/// `project_root` is the absolute path of the active project's root (the
/// dir containing the user's `.env` / `.env.local`). `None` means there's
/// no project-level layer (the spawn is workspace-scoped).
///
/// `workspace_env_path` is `<app_data_dir>/workspace.env` — typically
/// resolved by the caller via `app.path().app_data_dir()`.
///
/// Returns only the additive map. The caller layers this onto
/// `Command::envs()` so the process env (which Tauri inherits) stays the
/// baseline.
pub fn build_layered_env(
    workspace_env_path: Option<&Path>,
    project_root: Option<&Path>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Some(ws) = workspace_env_path {
        for (k, v) in parse_env_file(ws) {
            env.insert(k, v);
        }
    }
    if let Some(root) = project_root {
        for (k, v) in parse_env_file(&root.join(".env")) {
            env.insert(k, v);
        }
        for (k, v) in parse_env_file(&root.join(".env.local")) {
            env.insert(k, v);
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_key_value() {
        let m = parse_env_string("FOO=bar\nBAZ=qux\n");
        assert_eq!(m.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(m.get("BAZ"), Some(&"qux".to_string()));
    }

    #[test]
    fn parses_quoted_values() {
        let m =
            parse_env_string("DOUBLE=\"hello world\"\nSINGLE='literal $stuff'\nESC=\"line\\nbreak\"\n");
        assert_eq!(m.get("DOUBLE"), Some(&"hello world".to_string()));
        assert_eq!(m.get("SINGLE"), Some(&"literal $stuff".to_string()));
        assert_eq!(m.get("ESC"), Some(&"line\nbreak".to_string()));
    }

    #[test]
    fn strips_export_prefix_and_comments() {
        let m = parse_env_string("# top comment\nexport FOO=bar\n\n  # indent comment\nBAZ=qux\n");
        assert_eq!(m.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(m.get("BAZ"), Some(&"qux".to_string()));
    }

    #[test]
    fn skips_invalid_keys() {
        let m = parse_env_string("123=invalid\nVALID=ok\n=no-key\n");
        assert!(m.get("123").is_none());
        assert!(m.get("").is_none());
        assert_eq!(m.get("VALID"), Some(&"ok".to_string()));
    }

    #[test]
    fn trailing_comment_on_unquoted() {
        let m = parse_env_string("FOO=bar # inline\n");
        assert_eq!(m.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn build_layered_overrides_workspace_with_project() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("workspace.env");
        std::fs::write(&ws, "FOO=workspace\nSHARED=ws-only\n").unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join(".env"), "FOO=project\n").unwrap();
        std::fs::write(project.join(".env.local"), "BAR=local-only\n").unwrap();
        let env = build_layered_env(Some(&ws), Some(&project));
        assert_eq!(env.get("FOO"), Some(&"project".to_string()));
        assert_eq!(env.get("SHARED"), Some(&"ws-only".to_string()));
        assert_eq!(env.get("BAR"), Some(&"local-only".to_string()));
    }
}
