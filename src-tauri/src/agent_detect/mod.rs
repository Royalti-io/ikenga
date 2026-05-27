//! First-run wizard discovery: system + agent + agent-config inventory.
//!
//! All three Tauri commands are async (the agent scan runs subprocesses)
//! and return rich JSON-serializable structs the wizard renders verbatim.

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
pub async fn detect_agent(agent_id: String) -> Result<Option<DetectedAgent>, String> {
    Ok(agents::detect_by_id(&agent_id).await)
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
    /// True when `path` was confirmed to exist on disk via `metadata()`.
    /// When false, the wizard renders it as a best-effort guess so the
    /// user can verify before adding it as a project root.
    pub path_verified: bool,
}

/// Scan `~/.claude/projects/` for project session directories. Each entry
/// reflects a slugged project path (Claude Code encodes the real path by
/// replacing `/` with `-`). The Phase 4 roots step uses this to seed
/// suggestions for `claudeProjectRoots`.
#[tauri::command]
pub async fn list_claude_projects() -> Result<Vec<ClaudeProjectEntry>, String> {
    let home = match crate::platform::home_dir() {
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
        // wizard can present the real path as a suggestion. Inversion is
        // ambiguous (path components can themselves contain `-`), so prefer
        // an existence-checked candidate and fall back to the naive
        // all-slash replacement when nothing exists.
        let (decoded, path_verified) = decode_claude_slug_with_fs(&slug);

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
            path_verified,
        });
    }

    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(out)
}

/// Pure-string fallback used when no FS probe matches: prepend `/` and
/// replace every `-` with `/`. Exposed for unit tests.
pub fn decode_claude_slug_naive(slug: &str) -> String {
    if slug.starts_with('-') {
        let mut s = String::from("/");
        s.push_str(&slug[1..].replace('-', "/"));
        s
    } else {
        slug.to_string()
    }
}

/// Greedy existence-checked decoder. Returns `(path, verified)` where
/// `verified` is true iff `metadata(path)` succeeded.
///
/// Approach: tokenise on `-` after dropping the leading dash. Walk forward
/// building up a path; for each token decide whether to join with `/`,
/// `-`, `_`, or `.` based on which (if any) candidate currently exists on
/// disk. We always prefer the `/` candidate first — that's the canonical
/// Claude encoding. When no candidate exists we keep the partial-FS-aware
/// walk (every verified prefix stays accurate; only the unknown tail
/// defaults to `/`), because that's strictly more useful than discarding
/// the walk in favour of an all-slashes naive form.
pub fn decode_claude_slug_with_fs(slug: &str) -> (String, bool) {
    decode_claude_slug_with_probe(slug, |p| std::path::Path::new(p).exists())
}

/// Test-seam over `decode_claude_slug_with_fs`. The probe closure stands
/// in for the real filesystem so unit tests can assert the greedy walk
/// against a fixture set without touching `~/`.
pub fn decode_claude_slug_with_probe<F: Fn(&str) -> bool>(slug: &str, exists: F) -> (String, bool) {
    if !slug.starts_with('-') {
        return (slug.to_string(), exists(slug));
    }
    let body = &slug[1..];
    let tokens: Vec<&str> = body.split('-').collect();
    if tokens.is_empty() {
        return ("/".to_string(), false);
    }

    // Seed: leading `/<first-token>`. We don't FS-check this — the user's
    // FS root almost certainly contains it (`/Users`, `/home`, etc.).
    let mut acc = format!("/{}", tokens[0]);

    // Probe order: '/' first (canonical Claude encoding) then '-', '_',
    // '.'. Claude Code encodes any of these as '-' on disk, so we have to
    // try each at every token boundary. The first existing candidate wins;
    // when none exist we keep the '/' join (preserves any earlier verified
    // prefix and defaults the unknown tail to canonical slashes).
    const SEPARATORS: [char; 4] = ['/', '-', '_', '.'];

    for tok in &tokens[1..] {
        let candidates: Vec<String> = SEPARATORS
            .iter()
            .map(|sep| format!("{}{}{}", acc, sep, tok))
            .collect();
        acc = candidates
            .iter()
            .find(|p| exists(p))
            .cloned()
            .unwrap_or_else(|| candidates[0].clone());
    }

    let verified = exists(&acc);
    // Keep the partial-FS-aware result regardless of whether the final
    // full path verifies. Any prefix that matched on disk is real; the
    // unverified tail is still more useful than the all-slashes naive
    // form (which would lose every dash boundary the walk just proved).
    (acc, verified)
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

#[cfg(test)]
mod claude_slug_tests {
    use super::*;
    use std::collections::HashSet;

    fn probe<'a>(set: &'a HashSet<&'static str>) -> impl Fn(&str) -> bool + 'a {
        move |p| set.contains(p)
    }

    #[test]
    fn naive_decoder_replaces_all_dashes() {
        // No FS context — pure transform.
        assert_eq!(
            decode_claude_slug_naive("-Users-alice-work-stuff-proj"),
            "/Users/alice/work/stuff/proj"
        );
        assert_eq!(decode_claude_slug_naive("plain"), "plain");
    }

    #[test]
    fn greedy_decoder_keeps_hyphenated_component_when_disk_says_so() {
        // Hypothetical disk: `/Users/alice/work-stuff/proj` exists, but
        // `/Users/alice/work` does not. The greedy walk should prefer the
        // dash join at the `work` → `stuff` boundary.
        let set: HashSet<&'static str> = [
            "/Users/alice",
            "/Users/alice/work-stuff",
            "/Users/alice/work-stuff/proj",
        ]
        .into_iter()
        .collect();
        let (path, verified) =
            decode_claude_slug_with_probe("-Users-alice-work-stuff-proj", probe(&set));
        assert_eq!(path, "/Users/alice/work-stuff/proj");
        assert!(verified);
    }

    #[test]
    fn greedy_decoder_returns_canonical_slashed_form_when_nothing_exists() {
        // No FS info available. Walk defaults to '/' joins for every
        // unknown boundary — same shape as the old naive fallback but
        // produced by the walk itself.
        let set: HashSet<&'static str> = HashSet::new();
        let (path, verified) =
            decode_claude_slug_with_probe("-Users-alice-work-stuff-proj", probe(&set));
        assert_eq!(path, "/Users/alice/work/stuff/proj");
        assert!(!verified);
    }

    #[test]
    fn greedy_decoder_preserves_verified_prefix_when_tail_missing() {
        // The regression case from the onboarding screenshot:
        // `~/royalti-co/royalti-client-2.5` doesn't exist on this machine,
        // but `~/royalti-co` does. We must preserve the dash boundary that
        // FS proved, instead of collapsing the whole path to slashes.
        let set: HashSet<&'static str> = ["/home/x", "/home/x/royalti-co"].into_iter().collect();
        let (path, verified) =
            decode_claude_slug_with_probe("-home-x-royalti-co-royalti-client-2-5", probe(&set));
        assert_eq!(path, "/home/x/royalti-co/royalti/client/2/5");
        assert!(!verified);
    }

    #[test]
    fn greedy_decoder_resolves_dot_separator() {
        // Claude Code encodes `.` as `-` in slugs, so `royalti-client-2.5`
        // becomes `-...-royalti-client-2-5`. The greedy walk must try
        // `2.5` as a candidate when the FS knows about it.
        let set: HashSet<&'static str> = [
            "/Users/alice",
            "/Users/alice/work",
            "/Users/alice/work/v2.5",
        ]
        .into_iter()
        .collect();
        let (path, verified) = decode_claude_slug_with_probe("-Users-alice-work-v2-5", probe(&set));
        assert_eq!(path, "/Users/alice/work/v2.5");
        assert!(verified);
    }

    #[test]
    fn greedy_decoder_resolves_underscore_separator() {
        // Underscores in original paths get encoded to '-' too. The walk
        // tries '_' once '/' and '-' both fail.
        let set: HashSet<&'static str> = ["/Users/alice", "/Users/alice/my_proj"]
            .into_iter()
            .collect();
        let (path, verified) = decode_claude_slug_with_probe("-Users-alice-my-proj", probe(&set));
        assert_eq!(path, "/Users/alice/my_proj");
        assert!(verified);
    }

    #[test]
    fn greedy_decoder_handles_canonical_slash_path() {
        // Every prefix exists with slashes — should hand back the
        // canonical slashed form verbatim.
        let set: HashSet<&'static str> = [
            "/Users",
            "/Users/iyke",
            "/Users/iyke/projects",
            "/Users/iyke/projects/foo",
        ]
        .into_iter()
        .collect();
        let (path, verified) =
            decode_claude_slug_with_probe("-Users-iyke-projects-foo", probe(&set));
        assert_eq!(path, "/Users/iyke/projects/foo");
        assert!(verified);
    }

    #[test]
    fn greedy_decoder_prefers_slash_when_both_candidates_exist() {
        // Edge case: both `/a/b` and `/a-b` exist. Slash wins (canonical
        // Claude encoding) so the user lands on the more common case.
        let set: HashSet<&'static str> = ["/a", "/a/b", "/a-b"].into_iter().collect();
        let (path, _) = decode_claude_slug_with_probe("-a-b", probe(&set));
        assert_eq!(path, "/a/b");
    }
}
