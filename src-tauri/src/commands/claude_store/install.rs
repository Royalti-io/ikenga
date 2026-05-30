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

use std::sync::Arc;

use tauri::State;

use super::resolve::{
    collect_satisfied, resolve_install_loop_core, resolve_requires_core, PrimitiveRef, RequiresGraph,
};
use crate::commands::db::PaDb;
use crate::pkg::manifest::RequiresEntry;

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
) -> Result<(PathBuf, Option<String>, Vec<RequiresEntry>), String> {
    match source {
        ProvenanceSource::Git | ProvenanceSource::Catalog => {
            let staging = staging_dir("git");
            let res = (|| {
                git_clone(url, ref_, &staging)?;
                let sha = git_head_sha(&staging)?;
                let located = locate_in_clone(&staging, kind, name)?;
                // WP-14: the compiled `requires` live in the published
                // `manifest.json` — at the package/clone root for an `ikenga-pkgs`
                // skill (skills/<name>/ layout), or beside SKILL.md for a
                // skill-at-root. Read the clone root first, fall back to the
                // located primitive dir.
                let mut requires = read_manifest_requires(&staging);
                if requires.is_empty() {
                    requires = read_manifest_requires(&located);
                }
                // Don't carry the clone's `.git` into the vault canonical.
                let _ = std::fs::remove_dir_all(located.join(".git"));
                let dest = adopt_into_store(store, kind, name, &located)?;
                Ok::<_, String>((dest, Some(sha), requires))
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
                // The skills CLI writes only the skill dir (no package manifest),
                // so `requires` is best-effort here — read the skill dir itself.
                let requires = read_manifest_requires(&located);
                // Best-effort version: resolve the source repo's HEAD SHA.
                let sha = git_ls_remote_sha(&gh_url(url), None).ok();
                let dest = adopt_into_store(store, kind, name, &located)?;
                Ok::<_, String>((dest, sha, requires))
            })();
            let _ = std::fs::remove_dir_all(&staging);
            res
        }
        ProvenanceSource::Local => Err("local entries have no remote to fetch from".to_string()),
    }
}

fn build_entry(
    kind: Kind,
    name: &str,
    dest: &Path,
    requires: Vec<RequiresEntry>,
    prov: RegistryProvenance,
) -> ClaudeStoreEntry {
    ClaudeStoreEntry {
        kind: kind.as_str().to_string(),
        name: name.to_string(),
        store_path: dest.to_string_lossy().to_string(),
        description: read_description(dest, kind),
        modified_ms: mtime_ms(dest),
        enabled_in: Vec::new(),
        // WP-12/WP-14: the compiled `requires` are read from the fetched
        // primitive's `manifest.json` (the publish-time lift writes them there)
        // and recorded here so `claude_store_list` + the resolver see them.
        requires,
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
    from_catalog: bool,
) -> Result<ClaudeStoreEntry, String> {
    ensure_file_based(kind)?;
    validate_name(name)?;
    let (dest, version, requires) = fetch_and_adopt(store, kind, name, source, url, ref_)?;
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
        // Phase 3: record the catalog discovery origin orthogonally to the
        // resolved fetch mechanism (`source`). Curated-catalog installs opt into
        // auto-update; plain git/npx installs do not (catalog ON, manual OFF).
        from_catalog,
        auto_update: from_catalog,
    };
    let entry = build_entry(kind, name, &dest, requires, prov);
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
    let (dest, version, requires) =
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
        // Preserve the Phase-3 discovery origin + auto-update opt-in across a
        // re-fetch — an update doesn't change where the primitive came from or
        // the user's auto-update preference.
        from_catalog: prov.from_catalog,
        auto_update: prov.auto_update,
    };
    let entry = build_entry(kind, name, &dest, requires, new_prov);
    let mut rf2 = registry::load(store);
    registry::upsert_record(&mut rf2, entry.clone());
    registry::save(store, &rf2)?;
    Ok(entry)
}

// ─── Phase 3 — auto-update trust policy (catalog ON, local/dev/manual OFF) ────

/// Per-entry outcome of a batch auto-update run. Mirrors `AutoUpdateRow` in
/// `tauri-cmd.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoUpdateRow {
    pub kind: String,
    pub name: String,
    /// `"updated"` (a stale entry was re-fetched), `"current"` (already at the
    /// latest), or `"error"` (the check/update failed — see `error`).
    pub status: String,
    /// Resolved version after a successful update; `None` on current/error.
    pub version: Option<String>,
    /// Populated only when `status == "error"`.
    pub error: Option<String>,
}

/// Summary of a batch auto-update run over every `auto_update`-opted entry.
/// Mirrors `AutoUpdateSummary` in `tauri-cmd.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoUpdateSummary {
    /// Names that were re-fetched (were behind).
    pub updated: Vec<AutoUpdateRow>,
    /// Names that were already current (no fetch).
    pub current: Vec<AutoUpdateRow>,
    /// Names whose check/update errored — the batch continues past each.
    pub errored: Vec<AutoUpdateRow>,
}

/// Run auto-updates across every registry entry with `auto_update == true`:
/// check each against its remote and re-fetch the stale ones. A per-entry error
/// is recorded and the batch continues (never aborts). Pure-core (store is a
/// parameter), tempdir-testable.
fn auto_update_all_core(store: &Path) -> AutoUpdateSummary {
    let rf = registry::load(store);
    // Snapshot the (kind, name) of opted-in entries up front; each update reloads
    // + rewrites registry.json, so we don't iterate a live-mutating list.
    let targets: Vec<(String, String)> = rf
        .entries
        .iter()
        .filter(|e| e.provenance.auto_update)
        .map(|e| (e.kind.clone(), e.name.clone()))
        .collect();

    let mut summary = AutoUpdateSummary {
        updated: Vec::new(),
        current: Vec::new(),
        errored: Vec::new(),
    };

    for (kind_s, name) in targets {
        let k = match Kind::parse(&kind_s) {
            Ok(k) => k,
            Err(e) => {
                summary.errored.push(AutoUpdateRow {
                    kind: kind_s,
                    name,
                    status: "error".into(),
                    version: None,
                    error: Some(e),
                });
                continue;
            }
        };
        match check_update_core(store, k, &name) {
            Ok(st) if st.behind => match update_core(store, k, &name) {
                Ok(entry) => {
                    tracing::info!(kind = %kind_s, name = %name, "oba auto-update: refreshed stale catalog entry");
                    summary.updated.push(AutoUpdateRow {
                        kind: kind_s,
                        name,
                        status: "updated".into(),
                        version: entry.provenance.version,
                        error: None,
                    });
                }
                Err(e) => {
                    tracing::warn!(kind = %kind_s, name = %name, error = %e, "oba auto-update: update failed");
                    summary.errored.push(AutoUpdateRow {
                        kind: kind_s,
                        name,
                        status: "error".into(),
                        version: None,
                        error: Some(e),
                    });
                }
            },
            Ok(st) => summary.current.push(AutoUpdateRow {
                kind: kind_s,
                name,
                status: "current".into(),
                version: st.current,
                error: None,
            }),
            Err(e) => {
                tracing::warn!(kind = %kind_s, name = %name, error = %e, "oba auto-update: check failed");
                summary.errored.push(AutoUpdateRow {
                    kind: kind_s,
                    name,
                    status: "error".into(),
                    version: None,
                    error: Some(e),
                });
            }
        }
    }
    summary
}

/// Set the `auto_update` flag on an installed managed entry and persist it to
/// `registry.json`. Returns the new flag value. Errors if the entry is absent.
fn set_auto_update_core(
    store: &Path,
    kind: Kind,
    name: &str,
    enabled: bool,
) -> Result<bool, String> {
    let mut rf = registry::load(store);
    let entry = rf
        .entries
        .iter_mut()
        .find(|e| e.kind == kind.as_str() && e.name == name)
        .ok_or_else(|| format!("{} {name:?} not in registry", kind.as_str()))?;
    entry.provenance.auto_update = enabled;
    registry::save(store, &rf)?;
    Ok(enabled)
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
    fromCatalog: Option<bool>,
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
        fromCatalog.unwrap_or(false),
    )
}

/// Install a primitive via the Claude `skills` CLI (`npx skills add <spec>`).
/// `fromCatalog` records that the install was discovered through the recommended
/// catalog (Phase 3) — set by the catalog Install path, omitted/false for a
/// direct npx install.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn oba_install_npx(
    kind: String,
    name: String,
    spec: String,
    fromCatalog: Option<bool>,
) -> Result<ClaudeStoreEntry, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    install_core(
        &store,
        k,
        &name,
        ProvenanceSource::Npx,
        &spec,
        None,
        fromCatalog.unwrap_or(false),
    )
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

/// Phase 3 — auto-update every `auto_update`-opted entry that's behind its
/// remote (FE-driven: called on the Ọba/catalog surface mount). Per-entry errors
/// are collected, never abort the batch. Returns a summary of updated / current /
/// errored entries.
#[tauri::command]
pub async fn oba_auto_update_all() -> Result<AutoUpdateSummary, String> {
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    Ok(auto_update_all_core(&store))
}

/// Phase 3 — toggle the per-entry auto-update opt-in and persist it to
/// `registry.json`. Returns the new flag value.
#[tauri::command]
pub async fn oba_set_auto_update(
    kind: String,
    name: String,
    enabled: bool,
) -> Result<bool, String> {
    let k = Kind::parse(&kind)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    set_auto_update_core(&store, k, &name, enabled)
}

// ─── WP-14 — forward-dependency resolution at install (ADR-015 §3b) ───────────
//
// `oba_install_with_deps` is the resolver-wired install: it fetches the target,
// reads the target's compiled `requires` (WP-12 lift, embedded in the fetched
// `manifest.json`), then installs the missing dependency closure transactionally
// in topological order via `resolve::resolve_install_loop_core`, rolling back
// every install (including the target) if any dependency fetch fails.
//
// The discovery catalog (`primitives.json`) carries no `requires`, so the FE
// passes a catalog SNAPSHOT (name → source+url); each fetched dependency's own
// `manifest.json` reveals its transitive `requires`, growing the graph across
// iterations (the install-then-reresolve loop). The real depth today is 1
// (skill-pa → skill-core), so it converges immediately, but the loop handles
// arbitrary acyclic depth and defends against cycles.

/// A catalog row the FE hands the installer so a dependency `(kind,name)` can be
/// resolved to a fetchable `(source,url)`. Mirrors the subset of
/// `PrimitiveCatalogEntry` (`primitives.ts`) the resolver needs.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogEntryRef {
    pub kind: String,
    pub name: String,
    /// `"git"` | `"npx"` — the fetch mechanism (mirrors the catalog `source`).
    pub source: String,
    /// git remote URL | npx/skills spec.
    pub url: String,
}

/// Result of a resolver-driven install: the target plus the dependency closure
/// that was auto-installed (topological enable order) and the deps that were
/// already present (surfaced for the WP-15 consent UX; never reinstalled).
#[derive(Debug, Clone, Serialize)]
pub struct InstallWithDepsResult {
    pub target: ClaudeStoreEntry,
    /// The auto-installed dependency closure, deepest-first (enable order).
    pub installed: Vec<ClaudeStoreEntry>,
    /// Deps already satisfied (store ∪ external) — listed, not installed.
    #[serde(rename = "alreadySatisfied")]
    pub already_satisfied: Vec<PrimitiveRef>,
}

/// Map a wire fetch-source string to the provenance enum (target + deps come in
/// as `"git"`/`"npx"`; `"catalog"` is tolerated and dispatches like git).
fn parse_source(s: &str) -> Result<ProvenanceSource, String> {
    match s {
        "git" => Ok(ProvenanceSource::Git),
        "npx" => Ok(ProvenanceSource::Npx),
        "catalog" => Ok(ProvenanceSource::Git),
        other => Err(format!("install source must be git|npx, got {other:?}")),
    }
}

/// Read a fetched primitive's compiled `requires` from its `manifest.json`
/// (the WP-12 lift writes it there). Absent/unreadable/array-less ⇒ no deps.
/// Ọba reads ONLY this compiled field — never `SKILL.md` (ADR-015 §3a).
fn read_manifest_requires(dir: &Path) -> Vec<RequiresEntry> {
    #[derive(Deserialize)]
    struct ManifestRequires {
        #[serde(default)]
        requires: Vec<RequiresEntry>,
    }
    let path = dir.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<ManifestRequires>(&raw)
        .map(|m| m.requires)
        .unwrap_or_default()
}

/// Roll back one fetched primitive: vault-delete its canonical + drop its
/// registry record. Best-effort (a rollback failure must not mask the original
/// error). Mirrors the removal half of `oba_safe_delete`.
fn rollback_install_kn(store: &Path, kind: Kind, name: &str) {
    if let Ok(canon) = store_path_for(store, kind, name) {
        if canon.is_dir() {
            let _ = std::fs::remove_dir_all(&canon);
        } else if canon.exists() {
            let _ = std::fs::remove_file(&canon);
        }
    }
    let mut rf = registry::load(store);
    rf.entries
        .retain(|e| !(e.kind == kind.as_str() && e.name == name));
    let _ = registry::save(store, &rf);
}

fn rollback_install(store: &Path, item: &RequiresEntry) {
    if let Ok(k) = Kind::parse(&item.kind) {
        rollback_install_kn(store, k, &item.name);
    }
}

/// Fetch + adopt one dependency named by `item`, resolving its `(source,url)`
/// from the catalog snapshot. Returns the dep's OWN revealed `requires` (read
/// from its fetched manifest) so the install loop can grow the graph for
/// transitive deps. Deps inherit catalog provenance (`from_catalog: true`).
fn install_dep(
    store: &Path,
    catalog: &[CatalogEntryRef],
    item: &RequiresEntry,
) -> Result<Vec<RequiresEntry>, String> {
    let k = Kind::parse(&item.kind)?;
    let cat = catalog
        .iter()
        .find(|c| c.kind == item.kind && c.name == item.name)
        .ok_or_else(|| {
            format!(
                "dependency {}:{} is not in the catalog snapshot; cannot resolve its source",
                item.kind, item.name
            )
        })?;
    let src = parse_source(&cat.source)?;
    let entry = install_core(store, k, &item.name, src, &cat.url, None, true)?;
    Ok(entry.requires)
}

/// The transactional resolver-driven install core (pure over `store` +
/// `scope_roots`, so it is tempdir-testable with the real `install_core`).
/// Installs the target, then its missing dependency closure in topological
/// order; on any dependency failure rolls back the closure AND the target.
///
/// NOTE on ordering: the target is fetched FIRST — we must read its
/// freshly-fetched `manifest.json` to learn its `requires` (the discovery
/// catalog carries none). For a vault add this is immaterial (placement/enable
/// is a separate step) and fully reversible — a closure failure rolls the
/// target back too. The returned `installed` list is in topological ENABLE
/// order (deepest dep first); the caller enables the closure, then the target.
#[allow(clippy::too_many_arguments)]
fn install_with_deps_core(
    store: &Path,
    scope_roots: &[PathBuf],
    kind: Kind,
    name: &str,
    source: ProvenanceSource,
    url: &str,
    ref_: Option<&str>,
    from_catalog: bool,
    catalog: &[CatalogEntryRef],
) -> Result<InstallWithDepsResult, String> {
    // 1. Fetch the target; its fetched manifest reveals its compiled `requires`.
    let target_entry = install_core(store, kind, name, source, url, ref_, from_catalog)?;
    let target_requires = target_entry.requires.clone();

    // 2. What's already present (store ∪ external masters). Read-only across the
    //    loop (a just-fetched node must NOT be marked satisfied or its revealed
    //    children would be pruned — the loop tracks fetched-ness separately).
    let satisfied = collect_satisfied(store, scope_roots);

    // 3. Deps already present up front (consent UX / WP-15) — best-effort.
    let already_satisfied =
        resolve_requires_core(&target_requires, &RequiresGraph::new(), &satisfied)
            .map(|p| p.already_satisfied)
            .unwrap_or_default();

    // 4. Install the missing closure transactionally. install_one reveals each
    //    dep's own requires (growing the graph); a failure rolls back the closure
    //    in reverse — then we also roll back the target and surface the error.
    let mut graph = RequiresGraph::new();
    let closure = match resolve_install_loop_core(
        &target_requires,
        &satisfied,
        &mut graph,
        |item| install_dep(store, catalog, item),
        |item| rollback_install(store, item),
    ) {
        Ok(c) => c,
        Err(e) => {
            // The loop rolled back the dependency closure; undo the target too.
            rollback_install_kn(store, kind, name);
            return Err(e.to_string());
        }
    };

    // 5. Map the topologically-ordered closure refs back to their store entries.
    let rf = registry::load(store);
    let installed: Vec<ClaudeStoreEntry> = closure
        .iter()
        .filter_map(|r| {
            rf.entries
                .iter()
                .find(|e| e.kind == r.kind && e.name == r.name)
                .cloned()
        })
        .collect();

    Ok(InstallWithDepsResult {
        target: target_entry,
        installed,
        already_satisfied,
    })
}

/// Re-verify, at enable time, which of `(kind,name)`'s recorded `requires` are
/// NOT currently present (a dep may have been removed since install). The FE
/// offers to re-fetch the returned set (WP-14 "re-verify-at-enable"). Empty ⇒
/// the closure is intact.
fn missing_requires_core(
    store: &Path,
    scope_roots: &[PathBuf],
    kind: Kind,
    name: &str,
) -> Vec<RequiresEntry> {
    let rf = registry::load(store);
    let Some(entry) = rf
        .entries
        .iter()
        .find(|e| e.kind == kind.as_str() && e.name == name)
    else {
        return Vec::new();
    };
    let satisfied = collect_satisfied(store, scope_roots);
    entry
        .requires
        .iter()
        .filter(|r| {
            !satisfied.contains(&PrimitiveRef {
                kind: r.kind.clone(),
                name: r.name.clone(),
            })
        })
        .cloned()
        .collect()
}

/// Install a primitive AND its forward-dependency closure (ADR-015 §3b / WP-14).
/// The FE passes a catalog snapshot so each dependency resolves to a fetchable
/// source; the missing closure auto-installs transactionally (rolled back with
/// the target on any failure). Returns the target + the installed closure
/// (enable order) + already-satisfied deps (consent UX).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn oba_install_with_deps(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
    source: String,
    url: String,
    gitRef: Option<String>,
    fromCatalog: Option<bool>,
    catalog: Vec<CatalogEntryRef>,
) -> Result<InstallWithDepsResult, String> {
    let k = Kind::parse(&kind)?;
    let src = parse_source(&source)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    let scope_roots = super::all_scope_roots(&db).await;
    install_with_deps_core(
        &store,
        &scope_roots,
        k,
        &name,
        src,
        &url,
        gitRef.as_deref(),
        fromCatalog.unwrap_or(false),
        &catalog,
    )
}

/// Re-verify a primitive's `requires` at enable time: return the recorded deps
/// that are no longer present (the FE offers to re-fetch them). WP-14
/// re-verify-at-enable.
#[tauri::command]
pub async fn oba_missing_requires(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    name: String,
) -> Result<Vec<RequiresEntry>, String> {
    let k = Kind::parse(&kind)?;
    validate_name(&name)?;
    let store = store_root().ok_or_else(|| "cannot resolve store root".to_string())?;
    let scope_roots = super::all_scope_roots(&db).await;
    Ok(missing_requires_core(&store, &scope_roots, k, &name))
}

// ─── Tests (git path: offline, deterministic against local file:// repos) ─────

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    // ── WP-14 — resolver-driven install (real install_core + rollback) ──────────

    /// A source repo holding a skill-at-root + a `manifest.json` carrying
    /// `requires` (the published-artifact shape the resolver reads).
    fn make_skill_repo_with_requires(
        base: &Path,
        dir: &str,
        skill_name: &str,
        requires_json: &str,
    ) -> String {
        let repo = base.join(dir);
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q"], &repo);
        git(&["config", "user.email", "t@t"], &repo);
        git(&["config", "user.name", "t"], &repo);
        std::fs::write(
            repo.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: d\n---\nbody"),
        )
        .unwrap();
        std::fs::write(
            repo.join("manifest.json"),
            format!("{{\"requires\":{requires_json}}}"),
        )
        .unwrap();
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "-m", "v1"], &repo);
        format!("file://{}", repo.display())
    }

    #[test]
    fn install_with_deps_auto_installs_the_closure() {
        let base = unique_tmp("wd_closure");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // target requires child; child requires nothing.
        let target_url = make_skill_repo_with_requires(
            &base,
            "parent",
            "parent",
            r#"[{"kind":"skill","name":"child"}]"#,
        );
        let child_url = make_skill_repo_with_requires(&base, "child", "child", "[]");

        let catalog = vec![CatalogEntryRef {
            kind: "skill".into(),
            name: "child".into(),
            source: "git".into(),
            url: child_url,
        }];

        let res = install_with_deps_core(
            &store,
            &[],
            Kind::Skill,
            "parent",
            ProvenanceSource::Git,
            &target_url,
            None,
            true,
            &catalog,
        )
        .expect("install with deps ok");

        assert_eq!(res.target.name, "parent");
        // the child was auto-installed (closure)
        assert_eq!(res.installed.len(), 1);
        assert_eq!(res.installed[0].name, "child");
        // both canonicals on disk
        assert!(store_path_for(&store, Kind::Skill, "parent")
            .unwrap()
            .join("SKILL.md")
            .is_file());
        assert!(store_path_for(&store, Kind::Skill, "child")
            .unwrap()
            .join("SKILL.md")
            .is_file());
        // both recorded; target carries its compiled requires
        let rf = registry::load(&store);
        let parent = rf.entries.iter().find(|e| e.name == "parent").unwrap();
        assert_eq!(parent.requires.len(), 1);
        assert_eq!(parent.requires[0].name, "child");
        assert!(rf.entries.iter().any(|e| e.name == "child"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn install_with_deps_skips_already_satisfied_dep() {
        let base = unique_tmp("wd_satisfied");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // pre-install the child directly so it is already satisfied
        let child_url = make_skill_repo_with_requires(&base, "child", "child", "[]");
        install_core(
            &store,
            Kind::Skill,
            "child",
            ProvenanceSource::Git,
            &child_url,
            None,
            false,
        )
        .unwrap();

        let target_url = make_skill_repo_with_requires(
            &base,
            "parent",
            "parent",
            r#"[{"kind":"skill","name":"child"}]"#,
        );
        let catalog = vec![CatalogEntryRef {
            kind: "skill".into(),
            name: "child".into(),
            source: "git".into(),
            url: child_url,
        }];

        let res = install_with_deps_core(
            &store,
            &[],
            Kind::Skill,
            "parent",
            ProvenanceSource::Git,
            &target_url,
            None,
            true,
            &catalog,
        )
        .unwrap();
        // child already present → not reinstalled, surfaced as already-satisfied
        assert!(res.installed.is_empty(), "no reinstall of satisfied dep");
        assert!(res.already_satisfied.iter().any(|p| p.name == "child"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn install_with_deps_rolls_back_target_on_dep_failure() {
        let base = unique_tmp("wd_rollback");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let target_url = make_skill_repo_with_requires(
            &base,
            "parent",
            "parent",
            r#"[{"kind":"skill","name":"child"}]"#,
        );
        // child repo has NO SKILL.md → install_core fails to locate → dep failure
        let bad = base.join("badchild");
        std::fs::create_dir_all(&bad).unwrap();
        git(&["init", "-q"], &bad);
        git(&["config", "user.email", "t@t"], &bad);
        git(&["config", "user.name", "t"], &bad);
        std::fs::write(bad.join("README.md"), "nothing").unwrap();
        git(&["add", "-A"], &bad);
        git(&["commit", "-q", "-m", "x"], &bad);
        let catalog = vec![CatalogEntryRef {
            kind: "skill".into(),
            name: "child".into(),
            source: "git".into(),
            url: format!("file://{}", bad.display()),
        }];

        let err = install_with_deps_core(
            &store,
            &[],
            Kind::Skill,
            "parent",
            ProvenanceSource::Git,
            &target_url,
            None,
            true,
            &catalog,
        )
        .unwrap_err();
        assert!(
            err.contains("failed installing dependency") || err.contains("no SKILL.md"),
            "dep failure surfaced: {err}"
        );
        // target rolled back: no canonical, registry empty (full rollback)
        assert!(!store_path_for(&store, Kind::Skill, "parent")
            .unwrap()
            .exists());
        assert!(
            registry::load(&store).entries.is_empty(),
            "full rollback leaves no records"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn install_core_records_compiled_requires_from_manifest() {
        let base = unique_tmp("wd_reqrecord");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let url = make_skill_repo_with_requires(
            &base,
            "solo",
            "solo",
            r#"[{"kind":"skill","name":"skill-core"}]"#,
        );
        let entry = install_core(
            &store,
            Kind::Skill,
            "solo",
            ProvenanceSource::Git,
            &url,
            None,
            false,
        )
        .unwrap();
        assert_eq!(entry.requires.len(), 1);
        assert_eq!(entry.requires[0].name, "skill-core");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_requires_core_reports_removed_dep() {
        let base = unique_tmp("wd_missing");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let url = make_skill_repo_with_requires(
            &base,
            "solo",
            "solo",
            r#"[{"kind":"skill","name":"child"}]"#,
        );
        install_core(
            &store,
            Kind::Skill,
            "solo",
            ProvenanceSource::Git,
            &url,
            None,
            false,
        )
        .unwrap();
        // child never installed → reported missing
        let missing = missing_requires_core(&store, &[], Kind::Skill, "solo");
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].name, "child");
        std::fs::remove_dir_all(&base).ok();
    }

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
            false,
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
            false,
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
        let err = install_core(
            &store,
            Kind::Hook,
            "x",
            ProvenanceSource::Git,
            "u",
            None,
            false,
        )
        .unwrap_err();
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
            false,
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

    // ─── Phase 3 — catalog discovery origin + auto-update trust policy ────────

    #[test]
    fn catalog_install_records_from_catalog_and_auto_update_on() {
        let base = unique_tmp("catalog_install");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (_repo, url) = make_skill_repo(&base, "demo", "a demo skill");

        // a catalog-discovered install (from_catalog = true) still resolves via git
        let entry = install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
            true,
        )
        .expect("install ok");

        // dispatch axis unchanged: the resolved mechanism stays Git
        assert_eq!(entry.provenance.source, ProvenanceSource::Git);
        // discovery origin recorded orthogonally
        assert!(entry.provenance.from_catalog, "catalog discovery recorded");
        // curated-catalog installs opt into auto-update
        assert!(entry.provenance.auto_update, "catalog → auto_update on");

        // persisted to registry.json (survives a reload)
        let rec = registry::load(&store)
            .entries
            .into_iter()
            .find(|e| e.name == "demo")
            .expect("recorded");
        assert!(rec.provenance.from_catalog);
        assert!(rec.provenance.auto_update);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn plain_git_install_is_not_catalog_discovered_and_auto_update_off() {
        let base = unique_tmp("plain_install");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (_repo, url) = make_skill_repo(&base, "demo", "a demo skill");

        // a direct (non-catalog) git install
        let entry = install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
            false,
        )
        .expect("install ok");

        assert!(
            !entry.provenance.from_catalog,
            "direct install is NOT catalog-discovered"
        );
        assert!(
            !entry.provenance.auto_update,
            "manual install → auto_update off (catalog ON, manual OFF)"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_preserves_from_catalog_and_auto_update() {
        let base = unique_tmp("update_preserves");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (repo, url) = make_skill_repo(&base, "demo", "v1");

        install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
            true,
        )
        .unwrap();

        // advance the source
        std::fs::write(repo.join("NEW.md"), "added\n").unwrap();
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "-m", "v2"], &repo);

        let updated = update_core(&store, Kind::Skill, "demo").unwrap();
        assert!(
            updated.provenance.from_catalog,
            "update preserves catalog origin"
        );
        assert!(
            updated.provenance.auto_update,
            "update preserves auto_update opt-in"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_auto_update_round_trips_through_registry() {
        let base = unique_tmp("set_auto");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let (_repo, url) = make_skill_repo(&base, "demo", "a demo skill");

        // plain install → auto_update off
        install_core(
            &store,
            Kind::Skill,
            "demo",
            ProvenanceSource::Git,
            &url,
            None,
            false,
        )
        .unwrap();
        let before = registry::load(&store)
            .entries
            .into_iter()
            .find(|e| e.name == "demo")
            .unwrap();
        assert!(!before.provenance.auto_update);

        // flip it on — persists
        assert!(set_auto_update_core(&store, Kind::Skill, "demo", true).unwrap());
        let on = registry::load(&store)
            .entries
            .into_iter()
            .find(|e| e.name == "demo")
            .unwrap();
        assert!(on.provenance.auto_update, "persisted on");

        // flip it back off — persists
        assert!(!set_auto_update_core(&store, Kind::Skill, "demo", false).unwrap());
        let off = registry::load(&store)
            .entries
            .into_iter()
            .find(|e| e.name == "demo")
            .unwrap();
        assert!(!off.provenance.auto_update, "persisted off");

        // absent entry errors
        let err = set_auto_update_core(&store, Kind::Skill, "ghost", true).unwrap_err();
        assert!(err.contains("not in registry"), "absent → error: {err}");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn auto_update_all_updates_only_stale_auto_update_entries_and_survives_errors() {
        let base = unique_tmp("auto_all");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();

        // (1) a catalog (auto_update) skill that WILL go stale
        let (stale_repo, stale_url) = {
            let repo = base.join("stale-repo");
            std::fs::create_dir_all(&repo).unwrap();
            git(&["init", "-q"], &repo);
            git(&["config", "user.email", "t@t"], &repo);
            git(&["config", "user.name", "t"], &repo);
            std::fs::write(repo.join("SKILL.md"), "---\nname: stale\n---\nv1").unwrap();
            git(&["add", "-A"], &repo);
            git(&["commit", "-q", "-m", "v1"], &repo);
            let url = format!("file://{}", repo.display());
            (repo, url)
        };
        install_core(
            &store,
            Kind::Skill,
            "stale",
            ProvenanceSource::Git,
            &stale_url,
            None,
            true, // catalog → auto_update on
        )
        .unwrap();

        // (2) a catalog (auto_update) skill that stays CURRENT
        let (_cur_repo, cur_url) = make_skill_repo(&base, "current", "stays current");
        install_core(
            &store,
            Kind::Skill,
            "current",
            ProvenanceSource::Git,
            &cur_url,
            None,
            true,
        )
        .unwrap();

        // (3) a plain (auto_update OFF) skill that is ALSO stale — must be skipped
        let (manual_repo, manual_url) = {
            let repo = base.join("manual-repo");
            std::fs::create_dir_all(&repo).unwrap();
            git(&["init", "-q"], &repo);
            git(&["config", "user.email", "t@t"], &repo);
            git(&["config", "user.name", "t"], &repo);
            std::fs::write(repo.join("SKILL.md"), "---\nname: manual\n---\nv1").unwrap();
            git(&["add", "-A"], &repo);
            git(&["commit", "-q", "-m", "v1"], &repo);
            let url = format!("file://{}", repo.display());
            (repo, url)
        };
        install_core(
            &store,
            Kind::Skill,
            "manual",
            ProvenanceSource::Git,
            &manual_url,
            None,
            false, // manual → auto_update off
        )
        .unwrap();

        // (4) an auto_update entry whose remote is GONE — check errors, batch survives
        {
            let mut rf = registry::load(&store);
            let mut prov = RegistryProvenance::local(
                store.join("skills/broken").to_string_lossy().to_string(),
            );
            prov.source = ProvenanceSource::Git;
            prov.url = Some(format!("file://{}/does-not-exist", base.display()));
            prov.managed = true;
            prov.auto_update = true;
            prov.from_catalog = true;
            registry::upsert_record(
                &mut rf,
                ClaudeStoreEntry {
                    kind: "skill".into(),
                    name: "broken".into(),
                    store_path: store.join("skills/broken").to_string_lossy().to_string(),
                    description: None,
                    modified_ms: 0,
                    enabled_in: vec![],
                    requires: vec![],
                    provenance: prov,
                },
            );
            registry::save(&store, &rf).unwrap();
        }

        // now make `stale` actually behind
        std::fs::write(stale_repo.join("NEW.md"), "added\n").unwrap();
        git(&["add", "-A"], &stale_repo);
        git(&["commit", "-q", "-m", "v2"], &stale_repo);
        // (advance manual's source too — to prove it's skipped by policy, not by being current)
        std::fs::write(manual_repo.join("NEW.md"), "added\n").unwrap();
        git(&["add", "-A"], &manual_repo);
        git(&["commit", "-q", "-m", "v2"], &manual_repo);

        let summary = auto_update_all_core(&store);

        // exactly `stale` was updated
        assert_eq!(
            summary.updated.len(),
            1,
            "only the stale auto entry updates"
        );
        assert_eq!(summary.updated[0].name, "stale");
        // `current` reported current
        assert!(summary.current.iter().any(|r| r.name == "current"));
        // `broken` errored but did NOT abort the batch
        assert!(summary.errored.iter().any(|r| r.name == "broken"));
        // `manual` (auto_update off) was never touched — not in any bucket
        let all_names: Vec<&str> = summary
            .updated
            .iter()
            .chain(summary.current.iter())
            .chain(summary.errored.iter())
            .map(|r| r.name.as_str())
            .collect();
        assert!(
            !all_names.contains(&"manual"),
            "auto_update=false entry must be skipped entirely"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn legacy_registry_without_phase3_fields_deserializes_with_defaults() {
        let base = unique_tmp("legacy_serde");
        let store = base.join("store");
        std::fs::create_dir_all(&store).unwrap();
        // a registry.json written before Phase 3 — no fromCatalog / autoUpdate keys
        let raw = format!(
            r#"{{"schemaVersion":1,"entries":[{{"kind":"skill","name":"x","storePath":"{p}","description":null,"modifiedMs":0,"enabledIn":[],"source":"git","url":"u","ref":null,"version":"sha","canonicalPath":"{p}","managed":true,"installedAt":"t","updatedAt":"t"}}]}}"#,
            p = store.join("skills/x").to_string_lossy()
        );
        std::fs::write(registry::registry_path(&store), raw).unwrap();
        let rf = registry::load(&store);
        assert_eq!(rf.entries.len(), 1);
        // the new fields default to false (back-compat)
        assert!(!rf.entries[0].provenance.from_catalog);
        assert!(!rf.entries[0].provenance.auto_update);
        // and the pre-existing fields still bind
        assert_eq!(rf.entries[0].provenance.source, ProvenanceSource::Git);
        assert_eq!(rf.entries[0].provenance.version.as_deref(), Some("sha"));
        std::fs::remove_dir_all(&base).ok();
    }
}
