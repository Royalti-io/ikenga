//! Filesystem path resolution for the storyboard subsystem.
//!
//! The video engine lives at `$HOME/royalti-co/royalti-video-engine`. Each
//! composition has a sibling directory under `compositions/{slug}/` with:
//!   - `storyboard.json` (managed by SQLite in PA; export-only)
//!   - `stills/{beat-id}-{rung}.png` (written by the engine CLI's still:beat)
//!   - `concepts/*.html` + sibling `*.md` walkthroughs (optional)
//!
//! Slug regex matches the upstream allowlist (`server/lib/paths.ts`).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use regex::Regex;

/// Resolve `$HOME/royalti-co/royalti-video-engine`. v1 is dev-only — same
/// constraint as phase 6's `pa_root()`.
pub fn engine_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow!("$HOME not set"))?;
    let root = PathBuf::from(home).join("royalti-co/royalti-video-engine");
    if !root.exists() {
        return Err(anyhow!(
            "engine root not found at {} — storyboard ops are dev-only in v1",
            root.display()
        ));
    }
    Ok(root)
}

pub fn compositions_dir() -> Result<PathBuf> {
    Ok(engine_root()?.join("compositions"))
}

fn slug_regex() -> Regex {
    Regex::new(r"^[a-z0-9_-]+$").expect("slug regex compiles")
}

fn validate_slug(slug: &str) -> Result<()> {
    if !slug_regex().is_match(slug) {
        return Err(anyhow!("invalid slug: {slug}"));
    }
    Ok(())
}

/// Resolve `compositions/{slug}/storyboard.json`. Validates slug and rejects
/// any path that escapes `compositions_dir()`.
pub fn storyboard_path(slug: &str) -> Result<PathBuf> {
    validate_slug(slug)?;
    let compositions = compositions_dir()?;
    let p = compositions.join(slug).join("storyboard.json");
    ensure_within(&p, &compositions)?;
    Ok(p)
}

/// Resolve `compositions/{slug}/stills/{beat}-{rung}.png`.
pub fn still_path(slug: &str, beat_id: &str, rung: &str) -> Result<PathBuf> {
    validate_slug(slug)?;
    validate_slug(beat_id)?;
    if !matches!(rung, "lofi" | "hifi") {
        return Err(anyhow!("invalid rung: {rung}"));
    }
    let compositions = compositions_dir()?;
    let p = compositions
        .join(slug)
        .join("stills")
        .join(format!("{beat_id}-{rung}.png"));
    ensure_within(&p, &compositions)?;
    Ok(p)
}

/// Resolve `compositions/{slug}/concepts/`.
pub fn concepts_dir(slug: &str) -> Result<PathBuf> {
    validate_slug(slug)?;
    let compositions = compositions_dir()?;
    let p = compositions.join(slug).join("concepts");
    ensure_within(&p, &compositions)?;
    Ok(p)
}

fn ensure_within(p: &Path, root: &Path) -> Result<()> {
    // Lexical check: the resolved path must remain under root. We don't
    // canonicalize because the leaf may not exist yet (writes to new beats).
    if !p.starts_with(root) {
        return Err(anyhow!("path escape: {} not under {}", p.display(), root.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_regex_accepts_valid() {
        let re = slug_regex();
        assert!(re.is_match("ask-roy"));
        assert!(re.is_match("ask_roy_v2"));
        assert!(re.is_match("a"));
        assert!(re.is_match("123"));
    }

    #[test]
    fn slug_regex_rejects_invalid() {
        let re = slug_regex();
        assert!(!re.is_match(""));
        assert!(!re.is_match("../etc"));
        assert!(!re.is_match("Ask-Roy"));
        assert!(!re.is_match("ask roy"));
        assert!(!re.is_match("ask/roy"));
    }
}
