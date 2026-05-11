//! `detect_agent_config(agent_id="claude-code", root_path)` — counts what
//! the user already has under `.claude/` for the given workspace root, plus
//! global counts under `~/.claude/projects/` and `~/.claude.json` MCP
//! servers.
//!
//! The wizard renders these so the user immediately sees what state they're
//! starting from (e.g. "12 skills, 3 agents already installed") and so the
//! "would you like to scaffold .claude/?" step can be skipped on workspaces
//! that already have one.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AgentConfigInventory {
    pub root_path: String,
    pub config_dir_present: bool,
    pub agent_count: u32,
    pub skill_count: u32,
    pub command_count: u32,
    pub mcp_server_count: u32,
    pub project_count: u32,
}

pub fn build_inventory(agent_id: &str, root_path: &str) -> AgentConfigInventory {
    let root = PathBuf::from(root_path);
    match agent_id {
        "claude-code" => build_claude_inventory(root),
        // Other agents: return an empty shell rather than erroring so the
        // wizard can show "no inventory yet" without crashing on first run
        // of a future agent.
        _ => AgentConfigInventory {
            root_path: root.display().to_string(),
            config_dir_present: false,
            agent_count: 0,
            skill_count: 0,
            command_count: 0,
            mcp_server_count: 0,
            project_count: 0,
        },
    }
}

fn build_claude_inventory(root: PathBuf) -> AgentConfigInventory {
    let dot_claude = root.join(".claude");
    let config_dir_present = dot_claude.is_dir();

    let agent_count = count_markdown_files(&dot_claude.join("agents"));
    let skill_count = count_skill_dirs(&dot_claude.join("skills"));
    let command_count = count_markdown_files(&dot_claude.join("commands"));
    let mcp_server_count = count_mcp_servers();
    let project_count = count_projects();

    AgentConfigInventory {
        root_path: root.display().to_string(),
        config_dir_present,
        agent_count,
        skill_count,
        command_count,
        mcp_server_count,
        project_count,
    }
}

/// Count `.md` files at the top level of `dir`. Doesn't recurse — agents
/// and commands are flat-file by convention.
fn count_markdown_files(dir: &Path) -> u32 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n: u32 = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        {
            n = n.saturating_add(1);
        }
    }
    n
}

/// Skills are directories under `.claude/skills/` with a `SKILL.md` inside.
fn count_skill_dirs(dir: &Path) -> u32 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n: u32 = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            n = n.saturating_add(1);
        }
    }
    n
}

/// MCP servers are configured in `~/.claude.json` (user-global) under
/// `mcpServers`. Return 0 on parse failure or missing file — we don't want
/// the wizard to fail loudly on a malformed JSON file.
fn count_mcp_servers() -> u32 {
    let Some(path) = home_join(".claude.json") else {
        return 0;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return 0;
    };
    v.get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|m| u32::try_from(m.len()).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

/// Claude Code stores per-cwd session histories under `~/.claude/projects/`.
/// Each subdir is a hashed project root. Counting tells the user "you have
/// N existing projects" — useful framing for the wizard.
fn count_projects() -> u32 {
    let Some(path) = home_join(".claude/projects") else {
        return 0;
    };
    let Ok(rd) = std::fs::read_dir(&path) else {
        return 0;
    };
    let mut n: u32 = 0;
    for entry in rd.flatten() {
        if entry.path().is_dir() {
            n = n.saturating_add(1);
        }
    }
    n
}

fn home_join(rel: &str) -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn returns_empty_for_missing_root() {
        let inv = build_inventory(
            "claude-code",
            "/definitely/does/not/exist/ikenga-detect-test",
        );
        assert!(!inv.config_dir_present);
        assert_eq!(inv.agent_count, 0);
        assert_eq!(inv.skill_count, 0);
        assert_eq!(inv.command_count, 0);
    }

    #[test]
    fn counts_markdown_files_and_skill_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let dot = root.join(".claude");
        fs::create_dir_all(dot.join("agents")).unwrap();
        fs::create_dir_all(dot.join("commands")).unwrap();
        fs::create_dir_all(dot.join("skills").join("foo")).unwrap();
        fs::create_dir_all(dot.join("skills").join("bar")).unwrap();
        // A skill dir without SKILL.md doesn't count.
        fs::create_dir_all(dot.join("skills").join("baz")).unwrap();

        fs::write(dot.join("agents/one.md"), "x").unwrap();
        fs::write(dot.join("agents/two.md"), "x").unwrap();
        fs::write(dot.join("agents/notes.txt"), "x").unwrap();
        fs::write(dot.join("commands/alpha.md"), "x").unwrap();
        fs::write(dot.join("skills/foo/SKILL.md"), "x").unwrap();
        fs::write(dot.join("skills/bar/SKILL.md"), "x").unwrap();

        let inv = build_inventory("claude-code", root.to_str().unwrap());
        assert!(inv.config_dir_present);
        assert_eq!(inv.agent_count, 2, "agents .md only");
        assert_eq!(inv.command_count, 1);
        assert_eq!(inv.skill_count, 2, "skill dirs with SKILL.md");
    }

    #[test]
    fn unknown_agent_returns_empty_shell() {
        let inv = build_inventory("not-a-real-agent", "/tmp/whatever");
        assert!(!inv.config_dir_present);
        assert_eq!(inv.agent_count, 0);
        assert_eq!(inv.skill_count, 0);
        assert_eq!(inv.command_count, 0);
        assert_eq!(inv.mcp_server_count, 0);
        assert_eq!(inv.project_count, 0);
    }
}
