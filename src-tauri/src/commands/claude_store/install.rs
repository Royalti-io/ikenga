//! Ọba Phase 2 (WP-07/08/09) — install from git / npx + update.
//!
//! Fetches a primitive's canonical master from a remote into the vault and keeps
//! it fresh. Design locked Round 4 (`plans/oba-registry`):
//!   - **Canonical layout is IN-PLACE, UNIFORM** — an installed master lives at
//!     the same `store/<kind>s/<name>` a copy-vault import uses. `oba_update`
//!     re-fetches into that same path (atomic swap) so existing symlinks resolve
//!     to the refreshed files with **no relink**.
//!   - **Install = ADD-TO-VAULT ONLY.** These commands create the canonical and
//!     record provenance; per-scope placement stays the separate
//!     `claude_primitive_enable` step. Nothing here touches a `.claude/` farm.
//!   - **`source:"git"`** = `git clone`; **`source:"npx"`** = `npx skills add <gh-spec>`.
//!   - **Public-only auth (v1)** — plain clone / npx, no credential handling.
//!     A private repo fails with a clear error.
//!   - **File-based primitives only** (skill/agent/command). hook/mcp are
//!     JSON-fragments owned by the merge engine, not vault masters — rejected.
//!
//! The fetch always lands in a disposable staging dir first; only an atomic swap
//! promotes it into the vault, so a failed/interrupted fetch never leaves a
//! half-written canonical and never mutates `registry.json`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::registry;
use super::{
    atomic_copy_dir, atomic_copy_file, read_description, store_path_for, validate_name,
    ClaudeStoreEntry, Kind, ProvenanceSource, RegistryProvenance,
};
use crate::commands::claude_config::{mtime_ms, store_root};

/// Result of an update check — current (recorded) vs latest (remote) version.
/// Mirrors `UpdateStatus` in `tauri-cmd.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateStatus {
    /// Recorded resolved version (git SHA / npm spec SHA); `None` if never resolved.
    pub current: Option<String>,
    /// Latest resolved version at the remote.
    pub latest: Option<String>,
    /// `true` when `current != latest` (an update is available).
    pub behind: bool,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A disposable staging path under the system temp dir.
fn staging_dir(tag: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("oba-install-{tag}-{nonce}"))
}

/// Normalize a `git`/`owner/repo`/`github:` spec to an https clone URL.
fn gh_url(spec: &str) -> String {
    if spec.starts_with("http://") || spec.starts_with("https://") || spec.starts_with("git@") {
        spec.to_string()
    } else {
        format!("https://github.com/{}", spec.trim_start_matches("github:"))
    }
}

fn ensure_file_based(kind: Kind) -> Result<(), String> {
    if !kind.is_file_based() {
        return Err(format!(
            "kind {} is a JSON-fragment primitive (merge-engine owned); not installable as a vault master",
            kind.as_str()
        ));
    }
    Ok(())
}

// ─── git / npx invocation (shell out; public-only) ───────────────────────────

fn run(cmd: &str, args: &[&str], cwd: Option<&Path>) -> Result<std::process::Output, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("`{cmd}` not found on PATH — install it to use {cmd}-sourced primitives")
        } else {
            format!("{cmd}: {e}")
        }
    })
}

/// `git clone --depth 1 [--branch <ref>] <url> <dest>`. Public-only (no creds).
fn git_clone(url: &str, ref_: Option<&str>, dest: &Path) -> Result<(), String> {
    let dest_s = dest.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["clone", "--depth", "1"];
    if let Some(r) = ref_ {
        args.push("--branch");
        args.push(r);
    }
    args.push(url);
    args.push(&dest_s);
    let out = run("git", &args, None)?;
    if !out.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The cloned tree's HEAD commit SHA.
fn git_head_sha(dir: &Path) -> Result<String, String> {
    let dir_s = dir.to_string_lossy().to_string();
    let out = run("git", &["-C", &dir_s, "rev-parse", "HEAD"], None)?;
    if !out.status.success() {
        return Err(format!(
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve a remote ref to its SHA WITHOUT cloning (`git ls-remote <url> <ref>`).
/// `ref` defaults to `HEAD`. Returns the first column (the SHA).
fn git_ls_remote_sha(url: &str, ref_: Option<&str>) -> Result<String, String> {
    let r = ref_.unwrap_or("HEAD");
    let out = run("git", &["ls-remote", url, r], None)?;
    if !out.status.success() {
        return Err(format!(
            "git ls-remote failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("");
    if first.is_empty() {
        return Err(format!("git ls-remote returned no ref for {url} {r}"));
    }
    Ok(first.to_string())
}

/// `npx --yes skills add <spec>` with HOME + cwd pinned to `staging`, so whatever
/// the Claude `skills` CLI writes lands under our isolated tree (never the user's
/// real `~/.claude`). We adopt the written skill from there.
fn npx_skills_add(spec: &str, staging: &Path) -> Result<(), String> {
    let mut c = Command::new("npx");
    c.args(["--yes", "skills", "add", spec])
        .current_dir(staging)
        .env("HOME", staging);
    let out = c.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "`npx` not found on PATH — install Node.js to use npx-sourced primitives".to_string()
        } else {
            format!("npx: {e}")
        }
    })?;
    if !out.status.success() {
        return Err(format!(
            "npx skills add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// ─── locate the primitive inside a fetched tree ──────────────────────────────

/// Find the primitive content inside a freshly-cloned tree. Bounded, predictable
/// search (no deep guessing):
///   skill   → `<root>/SKILL.md` (root IS the skill) | `<root>/skills/<name>` | `<root>/<name>`
///   agent   → `<root>/<name>.md` | `<root>/agents/<name>.md`
///   command → `<root>/<name>.md` | `<root>/commands/<name>.md`
fn locate_in_clone(root: &Path, kind: Kind, name: &str) -> Result<PathBuf, String> {
    match kind {
        Kind::Skill => {
            if root.join("SKILL.md").is_file() {
                return Ok(root.to_path_buf());
            }
            for cand in [root.join("skills").join(name), root.join(name)] {
                if cand.join("SKILL.md").is_file() {
                    return Ok(cand);
                }
            }
            Err(format!(
                "no SKILL.md found in clone for skill {name:?} (looked at root, skills/{name}, {name})"
            ))
        }
        Kind::Agent | Kind::Command => {
            let leaf = format!("{name}.md");
            let mut cands = vec![root.join(&leaf)];
            if let Some(sub) = kind.dir_name() {
                cands.push(root.join(sub).join(&leaf));
            }
            for cand in cands {
                if cand.is_file() {
                    return Ok(cand);
                }
            }
            Err(format!(
                "no {name}.md found in clone for {} {name:?}",
                kind.as_str()
            ))
        }
        _ => Err("hook/mcp are JSON-fragment primitives; install via the merge engine".to_string()),
    }
}

/// Find the skill the `skills` CLI wrote under the staging dir — prefer the
/// expected `name`, else the single skill it produced. The `skills` CLI writes
/// to a CWD-relative `.agents/skills/<name>` (its universal cross-tool layout);
/// the other candidates are defensive fallbacks for layout changes.
fn locate_installed_skill(staging: &Path, name: &str) -> Result<PathBuf, String> {
    for skills_dir in [
        staging.join(".agents").join("skills"),
        staging.join(".claude").join("skills"),
        staging.join("skills"),
    ] {
        let named = skills_dir.join(name);
        if named.join("SKILL.md").is_file() {
            return Ok(named);
        }
        let mut found: Option<PathBuf> = None;
        if let Ok(rd) = std::fs::read_dir(&skills_dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.join("SKILL.md").is_file() {
                    if found.is_some() {
                        return Err(
                            "npx skills add produced multiple skills; expected exactly one"
                                .to_string(),
                        );
                    }
                    found = Some(p);
                }
            }
        }
        if let Some(p) = found {
            return Ok(p);
        }
    }
    Err(format!(
        "npx skills add produced no skill for {name:?} under the staging dir"
    ))
}

/// Copy the located primitive into the vault canonical at `store/<kind>s/<name>`,
/// atomically (the existing `atomic_copy_*` swap-over-existing-dst), and return
/// the canonical store path.
fn adopt_into_store(
    store: &Path,
    kind: Kind,
    name: &str,
    located: &Path,
) -> Result<PathBuf, String> {
    let dest = store_path_for(store, kind, name)?;
    if !dest.starts_with(store) {
        return Err(format!("install dest outside store: {}", dest.display()));
    }
    if kind.is_dir_primitive() {
        atomic_copy_dir(located, &dest)?;
    } else {
        atomic_copy_file(located, &dest)?;
    }
    Ok(dest)
}

// ─── fetch + adopt (shared by install + update) ──────────────────────────────

/// Fetch from the remote into staging, locate the primitive, atomically swap it
/// into the vault canonical, and clean up staging. Returns `(canonical, version)`.
/// The vault is mutated only by the final atomic swap, so a failure anywhere
/// before it leaves the prior canonical (if any) untouched.
fn fetch_and_adopt(
    store: &Path,
    kind: Kind,
    name: &str,
    source: ProvenanceSource,
    url: &str,
    ref_: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    match source {
        ProvenanceSource::Git | ProvenanceSource::Catalog => {
            let staging = staging_dir("git");
            let res = (|| {
                git_clone(url, ref_, &staging)?;
                let sha = git_head_sha(&staging)?;
                let located = locate_in_clone(&staging, kind, name)?;
                // Don't carry the clone's `.git` into the vault canonical.
                let _ = std::fs::remove_dir_all(located.join(".git"));
                let dest = adopt_into_store(store, kind, name, &located)?;
                Ok::<_, String>((dest, Some(sha)))
            })();
            let _ = std::fs::remove_dir_all(&staging);
            res
        }
        ProvenanceSource::Npx => {
            if kind != Kind::Skill {
                return Err(
                    "npx (skills CLI) installs skills only; use git for agents/commands"
                        .to_string(),
                );
            }
            let staging = staging_dir("npx");
            std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;
            let res = (|| {
                npx_skills_add(url, &staging)?;
                let located = locate_installed_skill(&staging, name)?;
                // Best-effort version: resolve the source repo's HEAD SHA.
                let sha = git_ls_remote_sha(&gh_url(url), None).ok();
                let dest = adopt_into_store(store, kind, name, &located)?;
                Ok::<_, String>((dest, sha))
            })();
            let _ = std::fs::remove_dir_all(&staging);
            res
        }
        ProvenanceSource::Local => Err("local entries have no remote to fetch from".to_string()),
    }
}

fn build_entry(kind: Kind, name: &str, dest: &Path, prov: RegistryProvenance) -> ClaudeStoreEntry {
    ClaudeStoreEntry {
        kind: kind.as_str().to_string(),
        name: name.to_string(),
        store_path: dest.to_string_lossy().to_string(),
        description: read_description(dest, kind),
        modified_ms: mtime_ms(dest),
        enabled_in: Vec::new(),
        provenance: prov,
    }
}

// ─── core (pure: store is a parameter, tempdir-testable) ──────────────────────

fn install_core(
    store: &Path,
    kind: Kind,
    name: &str,
    source: ProvenanceSource,
    url: &str,
    ref_: Option<&str>,
) -> Result<ClaudeStoreEntry, String> {
    ensure_file_based(kind)?;
    validate_name(name)?;
    let (dest, version) = fetch_and_adopt(store, kind, name, source, url, ref_)?;
    let now = now_iso();
    let prov = RegistryProvenance {
        source,
        url: Some(url.to_string()),
        r#ref: ref_.map(|s| s.to_string()),
        version,
        canonical_path: dest.to_string_lossy().to_string(),
        managed: true,
        installed_at: Some(now.clone()),
        updated_at: Some(now),
    };
    let entry = build_entry(kind, name, &dest, prov);
    let mut rf = registry::load(store);
    registry::upsert_record(&mut rf, entry.clone());
    registry::save(store, &rf)?;
    Ok(entry)
}

fn check_update_core(store: &Path, kind: Kind, name: &str) -> Result<UpdateStatus, String> {
    let rf = registry::load(store);
    let entry = rf
        .entries
        .iter()
        .find(|e| e.kind == kind.as_str() && e.name == name)
        .ok_or_else(|| format!("{} {name:?} not in registry", kind.as_str()))?;
    let prov = &entry.provenance;
    let url = prov
        .url
        .as_deref()
        .ok_or_else(|| "entry has no source url; nothing to check".to_string())?;
    let latest = match prov.source {
        ProvenanceSource::Git | ProvenanceSource::Catalog => {
            git_ls_remote_sha(url, prov.r#ref.as_deref())?
        }
        ProvenanceSource::Npx => git_ls_remote_sha(&gh_url(url), None)?,
        ProvenanceSource::Local => return Err("local entries have no remote to check".to_string()),
    };
    Ok(UpdateStatus {
        current: prov.version.clone(),
        behind: prov.version.as_deref() != Some(latest.as_str()),
        latest: Some(latest),
    })
}

fn update_core(store: &Path, kind: Kind, name: &str) -> Result<ClaudeStoreEntry, String> {
    let rf = registry::load(store);
    let existing = rf
        .entries
        .iter()
        .find(|e| e.kind == kind.as_str() && e.name == name)
        .cloned()
        .ok_or_else(|| {
            format!(
                "{} {name:?} not in registry; install it first",
                kind.as_str()
            )
        })?;
    let prov = existing.provenance.clone();
    if !prov.managed {
        return Err(format!(
            "{} {name:?} is an external master (kept in place) — update its source upstream, not here",
            kind.as_str()
        ));
    }
    let url = prov
        .url
        .clone()
        .ok_or_else(|| "entry has no source url; cannot update".to_string())?;
    let (dest, version) =
        fetch_and_adopt(store, kind, name, prov.source, &url, prov.r#ref.as_deref())?;
    let new_prov = RegistryProvenance {
        source: prov.source,
        url: prov.url.clone(),
        r#ref: prov.r#ref.clone(),
        version,
        canonical_path: dest.to_string_lossy().to_string(),
        managed: true,
        installed_at: prov.installed_at.clone(),
        updated_at: Some(now_iso()),
    };
    let entry = build_entry(kind, name, &dest, new_prov);
    let mut rf2 = registry::load(store);
    registry::upsert_record(&mut rf2, entry.clone());
    registry::save(store, &rf2)?;
    Ok(entry)
}

// ─── Tauri commands (thin: resolve the real store root, delegate to core) ─────

/// Install a primitive from a git remote into the vault as a managed canonical.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn oba_install_git(
    kind: String,
    name: String,
    url: String,
    gitRef: Option<String>,
) -> Result<ClaudeStoreEntry, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    install_core(
        &store,
        k,
        &name,
        ProvenanceSource::Git,
        &url,
        gitRef.as_deref(),
    )
}

/// Install a primitive via the Claude `skills` CLI (`npx skills add <spec>`).
#[tauri::command]
pub async fn oba_install_npx(
    kind: String,
    name: String,
    spec: String,
) -> Result<ClaudeStoreEntry, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    install_core(&store, k, &name, ProvenanceSource::Npx, &spec, None)
}

/// Check whether a git/npx-installed primitive is behind its remote.
#[tauri::command]
pub async fn oba_check_update(kind: String, name: String) -> Result<UpdateStatus, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    check_update_core(&store, k, &name)
}

/// Re-fetch a managed primitive into its existing canonical in place (no relink).
#[tauri::command]
pub async fn oba_update(kind: String, name: String) -> Result<ClaudeStoreEntry, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    update_core(&store, k, &name)
}

// ─── Tests (git path: offline, deterministic against local file:// repos) ─────

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn unique_tmp(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("oba_install_test_{tag}_{nonce}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn git(args: &[&str], cwd: &Path) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git available");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Create a bare-ish source git repo holding one skill named `name`, return
    /// its `file://` URL.
    fn make_skill_repo(base: &Path, name: &str, body: &str) -> (PathBuf, String) {
        let repo = base.join("src-repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q"], &repo);
        git(&["config", "user.email", "t@t"], &repo);
        git(&["config", "user.name", "t"], &repo);
        // Skill-at-root layout: SKILL.md + a helper at the repo root.
        std::fs::write(
            repo.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {body}\n---\nbody"),
        )
        .unwrap();
        std::fs::write(repo.join("helper.py"), "print(1)\n").unwrap();
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "-m", "v1"], &repo);
        let url = format!("file://{}", repo.display());
        (repo, url)
    }

    #[test]
    fn install_git_creates_canonical_and_records_provenance() {
        let base = unique_tmp("install_git");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (_repo, url) = make_skill_repo(&base, "demo", "a demo skill");

        let entry = install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
        )
        .expect("install ok");

        // canonical landed at store/skills/demo with the content (no .git)
        let canon = store_path_for(&store, Kind::Skill, "demo").unwrap();
        assert!(canon.join("SKILL.md").is_file());
        assert!(canon.join("helper.py").is_file());
        assert!(
            !canon.join(".git").exists(),
            ".git must not be copied into the vault"
        );

        // provenance recorded: git source, resolved SHA, managed
        assert_eq!(entry.provenance.source, ProvenanceSource::Git);
        assert!(entry.provenance.managed);
        let sha = entry.provenance.version.clone().expect("sha");
        assert_eq!(sha.len(), 40, "git SHA");

        // and it persisted to registry.json
        let rf = registry::load(&store);
        let rec = rf
            .entries
            .iter()
            .find(|e| e.name == "demo")
            .expect("recorded");
        assert_eq!(rec.provenance.version.as_deref(), Some(sha.as_str()));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn check_update_and_update_swap_in_place_without_relink() {
        let base = unique_tmp("update_git");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (repo, url) = make_skill_repo(&base, "demo", "v1 desc");

        install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
        )
        .unwrap();
        let canon = store_path_for(&store, Kind::Skill, "demo").unwrap();

        // a live dependent symlink into the canonical (the placement)
        let scope = base.join("proj").join(".claude").join("skills");
        std::fs::create_dir_all(&scope).unwrap();
        let link = scope.join("demo");
        std::os::unix::fs::symlink(&canon, &link).unwrap();
        assert!(link.join("SKILL.md").is_file(), "link resolves pre-update");

        // up to date
        let st = check_update_core(&store, Kind::Skill, "demo").unwrap();
        assert!(!st.behind, "freshly installed = not behind");

        // advance the source with a new commit (new file)
        std::fs::write(repo.join("NEW.md"), "added\n").unwrap();
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "-m", "v2"], &repo);

        let st2 = check_update_core(&store, Kind::Skill, "demo").unwrap();
        assert!(st2.behind, "source advanced → behind");
        assert_ne!(st2.current, st2.latest);

        let updated = update_core(&store, Kind::Skill, "demo").unwrap();
        assert_eq!(
            updated.provenance.version, st2.latest,
            "version bumped to latest"
        );
        // refreshed content is visible THROUGH the unchanged symlink (no relink)
        assert!(
            link.join("NEW.md").is_file(),
            "symlink resolves to refreshed files"
        );
        // not behind anymore
        let st3 = check_update_core(&store, Kind::Skill, "demo").unwrap();
        assert!(!st3.behind);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_refuses_external_master() {
        let base = unique_tmp("update_external");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // record an external (managed:false) master
        let mut rf = registry::load(&store);
        registry::upsert_external(&mut rf, "skill", "ext", "/elsewhere/ext");
        registry::save(&store, &rf).unwrap();

        let err = update_core(&store, Kind::Skill, "ext").unwrap_err();
        assert!(
            err.contains("external master"),
            "must refuse external: {err}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn locate_installed_skill_finds_agents_skills_layout() {
        // The `skills` CLI writes to a CWD-relative `.agents/skills/<name>`.
        let base = unique_tmp("locate_agents");
        let dir = base.join(".agents").join("skills").join("groundwork");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: groundwork\n---\nx").unwrap();
        let found = locate_installed_skill(&base, "groundwork").expect("found in .agents/skills");
        assert_eq!(found, dir);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn install_rejects_json_fragment_kinds() {
        let base = unique_tmp("reject_hook");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let err =
            install_core(&store, Kind::Hook, "x", ProvenanceSource::Git, "u", None).unwrap_err();
        assert!(
            err.contains("JSON-fragment"),
            "hook install must be rejected: {err}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn install_git_missing_skill_leaves_no_canonical_no_record() {
        let base = unique_tmp("install_missing");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // a repo with NO SKILL.md → locate fails after clone
        let repo = base.join("empty-repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q"], &repo);
        git(&["config", "user.email", "t@t"], &repo);
        git(&["config", "user.name", "t"], &repo);
        std::fs::write(repo.join("README.md"), "nothing here\n").unwrap();
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "-m", "x"], &repo);
        let url = format!("file://{}", repo.display());

        let err = install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
        )
        .unwrap_err();
        assert!(err.contains("no SKILL.md"), "should fail to locate: {err}");
        // no canonical, no registry mutation
        assert!(!store_path_for(&store, Kind::Skill, "demo")
            .unwrap()
            .exists());
        assert!(registry::load(&store).entries.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }
}
