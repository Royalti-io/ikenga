//! First-run wizard discovery: system + agent + agent-config inventory.
//!
//! All three Tauri commands are async (the agent scan runs subprocesses)
//! and return rich JSON-serializable structs the wizard renders verbatim.
//! See `.company/technical/plans/2026-05-11-ikenga-onboarding-wizard/`.

pub mod agents;
pub mod config_claude;
pub mod known;
pub mod scaffold;
pub mod system;

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

pub use agents::DetectedAgent;
pub use config_claude::AgentConfigInventory;
pub use scaffold::{ScaffoldFileResult, ScaffoldRequest, ScaffoldResponse};
pub use system::{CheckLevel, SystemCheck, SystemReport};

#[tauri::command]
pub async fn detect_system(app: tauri::AppHandle) -> Result<SystemReport, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    // build_report does only sync work (no subprocesses). Stay on the
    // current thread — `spawn_blocking` would be overkill.
    Ok(system::build_report(dir))
}

#[tauri::command]
pub async fn detect_agents() -> Result<Vec<DetectedAgent>, String> {
    Ok(agents::detect_all().await)
}

#[tauri::command]
pub async fn detect_agent_config(
    agent_id: String,
    root_path: String,
) -> Result<AgentConfigInventory, String> {
    Ok(config_claude::build_inventory(&agent_id, &root_path))
}

#[derive(Debug, Serialize)]
pub struct ClaudeProjectEntry {
    pub slug: String,
    pub path: String,
    pub display_path: String,
    pub session_count: u32,
    pub last_modified_ms: u64,
}

/// Scan `~/.claude/projects/` for project session directories. Each entry
/// reflects a slugged project path (Claude Code encodes the real path by
/// replacing `/` with `-`). The Phase 4 roots step uses this to seed
/// suggestions for `claudeProjectRoots`.
#[tauri::command]
pub async fn list_claude_projects() -> Result<Vec<ClaudeProjectEntry>, String> {
    let home = match std::env::var_os("HOME").map(PathBuf::from) {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let projects = home.join(".claude").join("projects");
    let read = match std::fs::read_dir(&projects) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out: Vec<ClaudeProjectEntry> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let slug = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Claude Code slugifies `/Users/iyke/royalti-co/ikenga/shell` →
        // `-Users-iyke-royalti-co-ikenga-shell`. Reverse the encoding so the
        // wizard can present the real path as a suggestion.
        let decoded = decode_claude_slug(&slug);

        // Count session files (jsonl entries) and grab newest mtime so the
        // wizard can sort recency-first.
        let mut session_count: u32 = 0;
        let mut last_modified_ms: u64 = 0;
        if let Ok(entries) = std::fs::read_dir(&path) {
            for f in entries.flatten() {
                let fp = f.path();
                if fp.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    session_count += 1;
                    if let Ok(md) = f.metadata() {
                        if let Ok(modified) = md.modified() {
                            if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                                let ms = dur.as_millis() as u64;
                                if ms > last_modified_ms {
                                    last_modified_ms = ms;
                                }
                            }
                        }
                    }
                }
            }
        }

        out.push(ClaudeProjectEntry {
            slug,
            path: decoded.clone(),
            display_path: contract_home(&decoded, &home),
            session_count,
            last_modified_ms,
        });
    }

    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(out)
}

fn decode_claude_slug(slug: &str) -> String {
    // Slugs are like `-Users-iyke-royalti-co-ikenga`. We can't perfectly
    // reverse the encoding (path components with internal hyphens are
    // lossy), but the canonical case is "leading dash + components joined
    // by dash", which inverts cleanly enough for the wizard's display
    // purpose.
    if slug.starts_with('-') {
        let mut s = String::from("/");
        s.push_str(&slug[1..].replace('-', "/"));
        s
    } else {
        slug.to_string()
    }
}

fn contract_home(path: &str, home: &std::path::Path) -> String {
    let home_str = match home.to_str() {
        Some(s) => s,
        None => return path.to_string(),
    };
    if let Some(rest) = path.strip_prefix(home_str) {
        format!("~{}", rest)
    } else {
        path.to_string()
    }
}

/// Phase 6 — agent-config scaffolder. Lays down the starter set of
/// agents/skills/commands for `provider` under `<root_path>/.claude/` (or
/// the provider's equivalent config dir). `mode` selects conflict
/// behaviour: `augment` (default, only writes missing files), `replace`
/// (overwrites everything), or `skip_conflicts` (same as augment but the
/// response records each skipped path so the wizard can show counts).
///
/// Backwards-compatible with the Phase 4 wrapper signature — it didn't
/// pass `mode`, so an absent value falls back to `augment` inside
/// `scaffold::scaffold`.
#[tauri::command]
pub async fn scaffold_agent_config(
    provider: String,
    root_path: String,
    profile: String,
    mode: Option<String>,
) -> Result<ScaffoldResponse, String> {
    scaffold::scaffold(ScaffoldRequest {
        provider,
        root_path,
        profile,
        mode,
    })
}
