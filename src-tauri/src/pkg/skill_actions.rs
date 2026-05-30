//! Skill-action discovery (WP-13: dispatch-only lighthouse).
//!
//! Reads an installed `kind: skill` pkg's
//! `<pkg_root>/<skills_dir>/<skill>/actions/*.md` files, parses the YAML
//! frontmatter between the leading `---` fences, and returns a flat list of
//! [`SkillAction`]s. The chrome renders each action as a button in the pkg's
//! pane header; for this MVP only `ux_mode: confirm` actions dispatch (the rest
//! render as disabled placeholders).
//!
//! Parsing is intentionally lenient: a file that fails to parse is skipped with
//! a `tracing::warn!` rather than aborting discovery for the whole pkg.
//!
//! Uses `serde_yaml` — already a direct dependency (frontmatter parsing for
//! `.claude/agents`/`skills`/`commands`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A single skill action, flattened for the TS renderer (camelCase over the
/// Tauri bridge). Mirrors the `SkillAction` interface in `src/types/pkg.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAction {
    pub pkg_id: String,
    /// The skill directory name (e.g. "pa").
    pub skill: String,
    /// The action verb — frontmatter `verb`/`name`, else the file stem.
    pub verb: String,
    /// Display name — frontmatter `name`, else the verb.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// One of: confirm | streaming | approve | (other). Only `confirm`
    /// dispatches in this MVP; everything else renders disabled.
    pub ux_mode: String,
    /// The `run.kind` (e.g. "chat_prompt").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_kind: Option<String>,
    /// The `run.prompt` template, if present — what gets seeded into chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<String>,
    /// The `inputs_schema` block re-serialized as a JSON string for the FE.
    /// (skill-pa authors it as `inputs_schema`, not `inputs.schema`.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs_schema_json: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
}

// ---- Frontmatter deserialization shapes -----------------------------------

#[derive(Debug, Deserialize)]
struct ActionFrontmatter {
    verb: Option<String>,
    name: Option<String>,
    description: Option<String>,
    domain: Option<String>,
    ux_mode: Option<String>,
    run: Option<RunBlock>,
    /// skill-pa authors this as a top-level `inputs_schema:` mapping.
    inputs_schema: Option<serde_yaml::Value>,
    #[serde(default)]
    depends_on: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RunBlock {
    kind: Option<String>,
    prompt: Option<String>,
}

/// Extract the YAML frontmatter block (between the leading `---` fences) from a
/// markdown file body. Returns `None` if the file does not start with a `---`
/// fence or the closing fence is missing.
fn extract_frontmatter(body: &str) -> Option<&str> {
    let trimmed = body.trim_start_matches('\u{feff}');
    // First line must be the opening fence.
    let first = trimmed.lines().next()?;
    if first.trim() != "---" {
        return None;
    }
    // Frontmatter starts right after the opening fence line.
    let after_open = trimmed.find('\n')? + 1;
    let rest = &trimmed[after_open..];
    // Line scan for the closing "---" fence; return everything before it.
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    None
}

/// Parse a single action `.md` file into a [`SkillAction`].
/// Returns `None` (and logs a warning) on any parse failure.
fn parse_action_file(pkg_id: &str, skill: &str, path: &Path) -> Option<SkillAction> {
    let body = match std::fs::read_to_string(path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(?path, error = %e, "skill_actions: failed to read action file");
            return None;
        }
    };

    let fm_src = match extract_frontmatter(&body) {
        Some(s) => s,
        None => {
            tracing::warn!(?path, "skill_actions: no YAML frontmatter fence; skipping");
            return None;
        }
    };

    let fm: ActionFrontmatter = match serde_yaml::from_str(fm_src) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(?path, error = %e, "skill_actions: frontmatter parse failed; skipping");
            return None;
        }
    };

    // verb falls back to `name`, then to the filename stem; name falls back to verb.
    let verb = fm.verb.or_else(|| fm.name.clone()).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("action")
            .to_string()
    });
    let name = fm.name.unwrap_or_else(|| verb.clone());
    let ux_mode = fm.ux_mode.unwrap_or_else(|| "streaming".to_string());

    let (run_kind, prompt_template) = match fm.run {
        Some(r) => (r.kind, r.prompt.map(|p| p.trim_end().to_string())),
        None => (None, None),
    };

    let inputs_schema_json = fm
        .inputs_schema
        .and_then(|v| serde_json::to_string(&v).ok());

    Some(SkillAction {
        pkg_id: pkg_id.to_string(),
        skill: skill.to_string(),
        verb,
        name,
        description: fm.description,
        domain: fm.domain,
        ux_mode,
        run_kind,
        prompt_template,
        inputs_schema_json,
        depends_on: fm.depends_on,
    })
}

/// Scan a resolved pkg root for skill actions.
///
/// `skills_dir` is the manifest's `skills` field (a relative dir like "skills").
/// Layout scanned: `<pkg_root>/<skills_dir>/<skill>/actions/*.md`.
/// Symlinked roots/skill dirs are followed by `std::fs` automatically (we use
/// `metadata()`, not `symlink_metadata()`), so dev-mounted (symlinked) pkgs
/// resolve transparently.
pub fn discover_actions(pkg_id: &str, pkg_root: &Path, skills_dir: &str) -> Vec<SkillAction> {
    let mut out = Vec::new();
    let skills_root = pkg_root.join(skills_dir);

    let skill_entries = match std::fs::read_dir(&skills_root) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(?skills_root, error = %e, "skill_actions: skills dir unreadable");
            return out;
        }
    };

    for skill_entry in skill_entries.flatten() {
        let skill_path = skill_entry.path();
        // Follow symlinks via metadata() (not symlink_metadata()).
        if !skill_path.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_name = match skill_path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let actions_dir = skill_path.join("actions");
        let action_entries = match std::fs::read_dir(&actions_dir) {
            Ok(e) => e,
            Err(_) => continue, // a skill without an actions/ dir is fine
        };
        for action_entry in action_entries.flatten() {
            let action_path = action_entry.path();
            if action_path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            // Skip non-action docs like actions/README.md.
            if action_path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.eq_ignore_ascii_case("README.md"))
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(action) = parse_action_file(pkg_id, &skill_name, &action_path) {
                out.push(action);
            }
        }
    }

    // Deterministic order: by skill then verb.
    out.sort_by(|a, b| a.skill.cmp(&b.skill).then(a.verb.cmp(&b.verb)));
    out
}

/// Resolve a pkg's on-disk root + skills dir, then discover its actions.
/// Returns an empty Vec if the pkg isn't a skill pkg or declares no `skills`
/// dir.
pub fn list_actions_for_pkg(
    pkg_id: &str,
    pkg_root: PathBuf,
    skills_dir: Option<&str>,
) -> Vec<SkillAction> {
    let Some(skills_dir) = skills_dir else {
        return Vec::new();
    };
    discover_actions(pkg_id, &pkg_root, skills_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_frontmatter_block() {
        let body = "---\nname: send\nux_mode: confirm\n---\n\n# body\n";
        let fm = extract_frontmatter(body).expect("frontmatter");
        assert!(fm.contains("name: send"));
        assert!(fm.contains("ux_mode: confirm"));
        assert!(!fm.contains("# body"));
    }

    #[test]
    fn no_frontmatter_returns_none() {
        assert!(extract_frontmatter("# just a heading\n").is_none());
    }

    #[test]
    fn parses_confirm_action_with_run_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let actions = dir.path().join("pa").join("actions");
        std::fs::create_dir_all(&actions).unwrap();
        let f = actions.join("send.md");
        std::fs::write(
            &f,
            "---\nname: send\ndescription: Dispatch approved items.\ndomain: tasks\nux_mode: confirm\nrun:\n  kind: chat_prompt\n  prompt: |\n    # PA Send Queue\n    Do the thing.\ndepends_on:\n  - skill-core\n---\n\n# action: send\n",
        )
        .unwrap();

        let actions = discover_actions("com.ikenga.skill-pa", dir.path(), ".");
        assert_eq!(actions.len(), 1);
        let a = &actions[0];
        assert_eq!(a.verb, "send");
        assert_eq!(a.ux_mode, "confirm");
        assert_eq!(a.run_kind.as_deref(), Some("chat_prompt"));
        assert!(a
            .prompt_template
            .as_deref()
            .unwrap()
            .contains("PA Send Queue"));
        assert_eq!(a.depends_on, vec!["skill-core".to_string()]);
    }

    #[test]
    fn skips_readme_and_unparseable() {
        let dir = tempfile::tempdir().unwrap();
        let actions = dir.path().join("pa").join("actions");
        std::fs::create_dir_all(&actions).unwrap();
        std::fs::write(actions.join("README.md"), "# readme, no frontmatter\n").unwrap();
        std::fs::write(actions.join("broken.md"), "no frontmatter here\n").unwrap();
        std::fs::write(
            actions.join("ok.md"),
            "---\nname: ok\nux_mode: streaming\n---\nbody\n",
        )
        .unwrap();

        let found = discover_actions("p", dir.path(), ".");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].verb, "ok");
    }
}
