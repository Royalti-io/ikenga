//! Concept HTML inventory — port of `server/lib/paths.ts::listConcepts`.
//!
//! Concepts are pre-Rung-0 mood frames stored as HTML files. Optional sibling
//! `.md` walkthroughs map beat ids → narrative descriptions. v1 ships the
//! data layer only; the picker UI is deferred to phase 7.1 (see inventory §6).

use std::collections::BTreeMap;
use std::fs;

use anyhow::Result;
use serde::Serialize;

use super::paths::concepts_dir;

#[derive(Debug, Clone, Serialize)]
pub struct ConceptFile {
    pub filename: String,
    pub angle: Option<String>,
    pub built: Option<String>,
    pub modified_at_ms: u64,
    pub size: u64,
    pub feel: Option<String>,
    pub beat_translations: BTreeMap<String, String>,
}

pub fn list_concepts(slug: &str) -> Result<Vec<ConceptFile>> {
    let dir = match concepts_dir(slug) {
        Ok(p) => p,
        Err(e) => return Err(e),
    };
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<ConceptFile> = vec![];
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.ends_with(".html") {
            continue;
        }
        let meta = entry.metadata()?;
        let modified_at_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let head = fs::read_to_string(&path)
            .map(|s| s.chars().take(1500).collect::<String>())
            .unwrap_or_default();
        let angle = capture_first(&head, r"(?i)Angle:\s*([^\n]+)").map(|s| s.trim().to_string());
        let built = capture_first(&head, r"(?i)Built:\s*([^\n]+)").map(|s| s.trim().to_string());

        let md_path = path.with_extension("md");
        let (feel, beats) = if md_path.exists() {
            parse_concept_markdown(&fs::read_to_string(&md_path).unwrap_or_default())
        } else {
            (None, BTreeMap::new())
        };

        entries.push(ConceptFile {
            filename: name.to_string(),
            angle,
            built,
            modified_at_ms,
            size: meta.len(),
            feel,
            beat_translations: beats,
        });
    }
    entries.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(entries)
}

fn capture_first(input: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(input)?.get(1).map(|m| m.as_str().to_string())
}

/// Parse a concept walkthrough markdown file. Format mirrors the upstream
/// `server/lib/paths.ts::parseConceptMarkdown`:
///
///     ---
///     feel: short summary
///     ---
///
///     ## hook
///     Narrative description.
///
///     ## pain
///     ...
fn parse_concept_markdown(src: &str) -> (Option<String>, BTreeMap<String, String>) {
    let mut feel = None;
    let mut body = src;

    if let Some(end) = src.strip_prefix("---\n").and_then(|s| s.find("\n---\n")) {
        // src starts with "---\n", then up to "\n---\n" is the frontmatter.
        let after_open = &src[4..]; // past "---\n"
        let head = &after_open[..end];
        body = &after_open[end + 5..]; // past "\n---\n"
        for line in head.lines() {
            if let Some(rest) = line.strip_prefix("feel:") {
                feel = Some(rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
            }
        }
    }

    let mut beats = BTreeMap::new();
    let header_re = regex::Regex::new(r"(?im)^##\s+([a-z0-9_-]+)\s*$").unwrap();
    let mut last_id: Option<String> = None;
    let mut last_start = 0;
    for cap in header_re.captures_iter(body) {
        let m = cap.get(0).unwrap();
        let id = cap.get(1).unwrap().as_str().to_string();
        if let Some(prev_id) = last_id.take() {
            let text = body[last_start..m.start()].trim().to_string();
            if !text.is_empty() {
                beats.insert(prev_id, text);
            }
        }
        last_id = Some(id);
        last_start = m.end();
    }
    if let Some(prev_id) = last_id {
        let text = body[last_start..].trim().to_string();
        if !text.is_empty() {
            beats.insert(prev_id, text);
        }
    }

    (feel, beats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_feel() {
        let src = "---\nfeel: warm and bright\n---\n\n## hook\nA description.\n";
        let (feel, beats) = parse_concept_markdown(src);
        assert_eq!(feel.as_deref(), Some("warm and bright"));
        assert_eq!(beats.get("hook").map(|s| s.as_str()), Some("A description."));
    }

    #[test]
    fn parses_multiple_beats() {
        let src = "## hook\none\n\n## pain\ntwo\n\n## solution\nthree\n";
        let (feel, beats) = parse_concept_markdown(src);
        assert_eq!(feel, None);
        assert_eq!(beats.len(), 3);
        assert_eq!(beats.get("hook").map(String::as_str), Some("one"));
        assert_eq!(beats.get("pain").map(String::as_str), Some("two"));
        assert_eq!(beats.get("solution").map(String::as_str), Some("three"));
    }
}
