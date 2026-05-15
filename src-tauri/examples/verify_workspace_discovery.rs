//! End-to-end probe for workspace pkg manifests.
//!
//! Walks the configured workspace dir (env IKENGA_WORKSPACE_DIR or
//! ~/royalti-co/ikenga/pkgs by default) and validates each manifest.json
//! against the Rust kernel's schema constraints:
//!   - reverse-DNS id (contains a dot)
//!   - ikenga_api parses as u32 within [1, 1]
//!   - sidecar names (if any) start with `pa-<pkg-slug>-`
//!
//! Mirrors what `Kernel::discover_workspace` does at runtime without
//! reaching into private kernel internals. A green run here means
//! `pkg_discover_workspace` will return one entry per pkg dir below.
//!
//! Run:
//!   cargo run --example verify_workspace_discovery

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Deserialize)]
struct ManifestProbe {
    id: String,
    name: String,
    version: String,
    ikenga_api: String,
    #[serde(default)]
    sidecars: Vec<SidecarProbe>,
}

#[derive(Deserialize)]
struct SidecarProbe {
    name: String,
}

fn validate(m: &ManifestProbe) -> Result<(), String> {
    if !m.id.contains('.') {
        return Err(format!("id `{}` is not reverse-DNS", m.id));
    }
    let api: u32 = m
        .ikenga_api
        .parse()
        .map_err(|_| format!("ikenga_api `{}` is not numeric", m.ikenga_api))?;
    if !(1..=1).contains(&api) {
        return Err(format!("ikenga_api {api} outside supported [1, 1]"));
    }
    let prefix = format!("pa-{}-", m.id.replace('.', "-"));
    for s in &m.sidecars {
        if !s.name.starts_with(&prefix) {
            return Err(format!("sidecar `{}` must start with `{prefix}`", s.name));
        }
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let workspace_dir = std::env::var("IKENGA_WORKSPACE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join("royalti-co/ikenga/pkgs")
        });
    println!("scanning {}\n", workspace_dir.display());

    let mut ok = 0usize;
    let mut bad = 0usize;
    for entry in std::fs::read_dir(&workspace_dir)?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("manifest.json");
        if !manifest.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&manifest)?;
        match serde_json::from_str::<ManifestProbe>(&raw) {
            Ok(m) => match validate(&m) {
                Ok(()) => {
                    ok += 1;
                    println!("  ok    {} v{}  ({})", m.id, m.version, m.name);
                }
                Err(e) => {
                    bad += 1;
                    println!("  fail  {}: {e}", path.display());
                }
            },
            Err(e) => {
                bad += 1;
                println!("  parse {}: {e}", path.display());
            }
        }
    }
    println!("\n{ok} ok, {bad} failed");
    if bad > 0 {
        std::process::exit(1);
    }
    Ok(())
}
