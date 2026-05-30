//! Forward-dependency resolver core (Ọba Phase 4, ADR-015 §3b / WP-13).
//!
//! Given a primitive's `requires` (the compiled forward-dependency edges, WP-11
//! field / WP-12 lift) and a snapshot of what's already present, compute the
//! **install closure** — the set of missing dependencies in **topological
//! order** so that installing the plan front-to-back always installs a dep
//! before anything that requires it.
//!
//! Design (WP-13 decisions):
//!   * **Pure single-pass core.** `resolve_requires_core` is a pure function over
//!     injected data — a `requires` graph (name → that primitive's requires) and
//!     a `satisfied` set. No disk, no network, trivially unit-testable. WP-14
//!     assembles the graph (the catalog's embedded-manifest `requires` lives on
//!     the TS side today; Rust has no native catalog reader) and the satisfied
//!     set, then drives the install loop over the plan.
//!   * **Satisfaction = store registry ∪ external masters.** A dep already in the
//!     Ọba vault (store registry) OR a CLI-installed external master
//!     (`scan_external_masters`) counts as satisfied and prunes its subtree.
//!     Pkg-bundled `EngineAssets` skills are **deliberately NOT** a satisfaction
//!     source — ADR-015 decision 4 hard-retires bundling (WP-17), so the resolver
//!     never couples to that doomed path.
//!   * **Cycle-safe.** The skill star is acyclic, but a pkg→skill `requires` DAG
//!     isn't guaranteed — a back-edge returns `ResolveError::Cycle(path)`, never
//!     a hang.
//!
//! This module is not yet wired into a Tauri command — that is WP-14 (wire the
//! resolver into `oba_install_*`/enable + transactional multi-install). The
//! `#![allow(dead_code)]` drops when WP-14 consumes this API.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pkg::manifest::RequiresEntry;

/// A primitive's identity in the dependency graph: `(kind, name)`.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct PrimitiveRef {
    pub kind: String,
    pub name: String,
}

impl PrimitiveRef {
    fn of(e: &RequiresEntry) -> Self {
        Self {
            kind: e.kind.clone(),
            name: e.name.clone(),
        }
    }
}

/// Maps a primitive to ITS OWN `requires` (the child edges). Assembled by WP-14
/// from the catalog (uninstalled deps) + installed store entries.
pub type RequiresGraph = HashMap<PrimitiveRef, Vec<RequiresEntry>>;

/// The computed install closure.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct InstallPlan {
    /// Missing deps to install, **topologically ordered** — installing
    /// front-to-back installs a dependency before any primitive that requires it.
    /// Each item is the `requires` edge that introduced the dep (carries the
    /// declared `source`/`ref` fetch hints for the installer).
    pub ordered: Vec<RequiresEntry>,
    /// Deps already present (store registry or external master). Surfaced for the
    /// consent UX (WP-15); never reinstalled.
    pub already_satisfied: Vec<PrimitiveRef>,
}

/// Resolver failure. The skill star is acyclic; this guards a pkg→skill DAG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// A `requires` cycle — the path that closes it (the repeated ref is last).
    Cycle(Vec<PrimitiveRef>),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::Cycle(path) => {
                let chain = path
                    .iter()
                    .map(|r| format!("{}:{}", r.kind, r.name))
                    .collect::<Vec<_>>()
                    .join(" → ");
                write!(f, "requires cycle detected: {chain}")
            }
        }
    }
}

/// Internal DFS state.
struct Resolver<'a> {
    graph: &'a RequiresGraph,
    satisfied: &'a HashSet<PrimitiveRef>,
    ordered: Vec<RequiresEntry>,
    done: HashSet<PrimitiveRef>,    // pushed to `ordered` already (dedupe diamonds)
    sat_seen: Vec<PrimitiveRef>,    // satisfied deps encountered (consent UX)
    sat_set: HashSet<PrimitiveRef>, // dedupe `sat_seen`
    onstack: HashSet<PrimitiveRef>, // ancestors on the current DFS path (cycle)
    stack: Vec<PrimitiveRef>,       // the path, for the cycle error
}

impl<'a> Resolver<'a> {
    fn visit(&mut self, edge: &RequiresEntry) -> Result<(), ResolveError> {
        let r = PrimitiveRef::of(edge);

        // Already present → prune the whole subtree (its own deps are its problem,
        // already resolved when IT was installed).
        if self.satisfied.contains(&r) {
            if self.sat_set.insert(r.clone()) {
                self.sat_seen.push(r);
            }
            return Ok(());
        }
        // Already planned via another edge (diamond) → skip; first edge wins.
        if self.done.contains(&r) {
            return Ok(());
        }
        // Back-edge to an ancestor → cycle.
        if self.onstack.contains(&r) {
            let mut path = self.stack.clone();
            path.push(r);
            return Err(ResolveError::Cycle(path));
        }

        self.onstack.insert(r.clone());
        self.stack.push(r.clone());
        if let Some(children) = self.graph.get(&r) {
            for child in children {
                self.visit(child)?;
            }
        }
        self.stack.pop();
        self.onstack.remove(&r);
        self.done.insert(r);
        // Post-order: children are already in `ordered`, so this dep lands after
        // its own deps → topological (deepest first).
        self.ordered.push(edge.clone());
        Ok(())
    }
}

/// Compute the install closure for `target`'s `requires`. Pure: no disk/network.
///
/// * `graph` — each known primitive → its own `requires` (child edges).
/// * `satisfied` — primitives already present (store ∪ external); prune on hit.
///
/// A dep absent from `graph` is treated as a leaf (no known children) and still
/// planned — the installer fetches it and its manifest reveals any further
/// `requires` at install time (the WP-14 install loop re-resolves).
pub fn resolve_requires_core(
    target: &[RequiresEntry],
    graph: &RequiresGraph,
    satisfied: &HashSet<PrimitiveRef>,
) -> Result<InstallPlan, ResolveError> {
    let mut r = Resolver {
        graph,
        satisfied,
        ordered: Vec::new(),
        done: HashSet::new(),
        sat_seen: Vec::new(),
        sat_set: HashSet::new(),
        onstack: HashSet::new(),
        stack: Vec::new(),
    };
    for edge in target {
        r.visit(edge)?;
    }
    Ok(InstallPlan {
        ordered: r.ordered,
        already_satisfied: r.sat_seen,
    })
}

/// Build the `satisfied` set from disk: every installed store-registry entry +
/// every external master in the live farm. Tempdir-testable (`store` +
/// `scope_roots` are parameters), mirroring the `*_core` pattern. Bundled
/// `EngineAssets` skills are intentionally excluded (see module docs).
pub fn collect_satisfied(store: &Path, scope_roots: &[PathBuf]) -> HashSet<PrimitiveRef> {
    let mut set = HashSet::new();
    // Installed in the Ọba vault.
    for e in &super::registry::load(store).entries {
        set.insert(PrimitiveRef {
            kind: e.kind.clone(),
            name: e.name.clone(),
        });
    }
    // CLI-installed externals kept in place (the `groundwork` shape).
    for (kind, name, _canon) in super::scan_external_masters(store, scope_roots) {
        set.insert(PrimitiveRef {
            kind: kind.as_str().to_string(),
            name,
        });
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg::manifest::RequireSource;

    fn req(name: &str) -> RequiresEntry {
        RequiresEntry {
            kind: "skill".into(),
            name: name.into(),
            source: None,
            r#ref: None,
        }
    }
    fn req_src(name: &str, source: RequireSource) -> RequiresEntry {
        RequiresEntry {
            kind: "skill".into(),
            name: name.into(),
            source: Some(source),
            r#ref: None,
        }
    }
    fn pref(name: &str) -> PrimitiveRef {
        PrimitiveRef {
            kind: "skill".into(),
            name: name.into(),
        }
    }
    fn graph(edges: &[(&str, &[&str])]) -> RequiresGraph {
        edges
            .iter()
            .map(|(node, deps)| {
                (pref(node), deps.iter().map(|d| req(d)).collect::<Vec<_>>())
            })
            .collect()
    }
    fn names(plan: &InstallPlan) -> Vec<String> {
        plan.ordered.iter().map(|e| e.name.clone()).collect()
    }

    #[test]
    fn all_satisfied_yields_empty_plan() {
        let g = graph(&[("a", &["skill-core"])]);
        let satisfied: HashSet<_> = [pref("skill-core")].into_iter().collect();
        let plan = resolve_requires_core(&[req("skill-core")], &g, &satisfied).unwrap();
        assert!(plan.ordered.is_empty());
        assert_eq!(plan.already_satisfied, vec![pref("skill-core")]);
    }

    #[test]
    fn single_missing_leaf_is_planned() {
        // the real skill-core case: target requires skill-core (which depends on
        // nothing), nothing installed → install skill-core.
        let g = graph(&[("skill-core", &[])]);
        let plan = resolve_requires_core(&[req("skill-core")], &g, &HashSet::new()).unwrap();
        assert_eq!(names(&plan), vec!["skill-core"]);
        assert!(plan.already_satisfied.is_empty());
    }

    #[test]
    fn transitive_closure_is_topologically_ordered() {
        // target → b → c (c deepest). Install order: c, b.
        let g = graph(&[("b", &["c"]), ("c", &[])]);
        let plan = resolve_requires_core(&[req("b")], &g, &HashSet::new()).unwrap();
        assert_eq!(names(&plan), vec!["c", "b"]);
    }

    #[test]
    fn satisfied_dep_prunes_its_subtree() {
        // b is external-satisfied → b skipped AND its child c is never visited.
        let g = graph(&[("b", &["c"]), ("c", &[])]);
        let satisfied: HashSet<_> = [pref("b")].into_iter().collect();
        let plan = resolve_requires_core(&[req("b")], &g, &satisfied).unwrap();
        assert!(plan.ordered.is_empty());
        assert_eq!(plan.already_satisfied, vec![pref("b")]);
    }

    #[test]
    fn diamond_dedupes_shared_dep() {
        // target → b, c ; b → d ; c → d. d appears once, before b and c.
        let g = graph(&[("b", &["d"]), ("c", &["d"]), ("d", &[])]);
        let plan =
            resolve_requires_core(&[req("b"), req("c")], &g, &HashSet::new()).unwrap();
        assert_eq!(names(&plan), vec!["d", "b", "c"]);
        // d only once
        assert_eq!(names(&plan).iter().filter(|n| *n == "d").count(), 1);
    }

    #[test]
    fn cycle_returns_error_not_hang() {
        // a → b → a
        let g = graph(&[("a", &["b"]), ("b", &["a"])]);
        let err = resolve_requires_core(&[req("a")], &g, &HashSet::new()).unwrap_err();
        match err {
            ResolveError::Cycle(path) => {
                assert_eq!(path.first(), Some(&pref("a")));
                assert_eq!(path.last(), Some(&pref("a"))); // closes the loop
            }
        }
    }

    #[test]
    fn self_cycle_is_detected() {
        let g = graph(&[("a", &["a"])]);
        assert!(matches!(
            resolve_requires_core(&[req("a")], &g, &HashSet::new()),
            Err(ResolveError::Cycle(_))
        ));
    }

    #[test]
    fn plan_items_carry_source_ref_hint() {
        // the edge's declared source is preserved on the plan item (the fetcher
        // needs it).
        let g = graph(&[("skill-core", &[])]);
        let plan =
            resolve_requires_core(&[req_src("skill-core", RequireSource::Npx)], &g, &HashSet::new())
                .unwrap();
        assert_eq!(plan.ordered[0].source, Some(RequireSource::Npx));
    }

    #[test]
    fn unknown_dep_is_planned_as_leaf() {
        // a dep absent from the graph is still installed (leaf); WP-14 re-resolves
        // its own requires at install time.
        let plan =
            resolve_requires_core(&[req("not-in-graph")], &HashMap::new(), &HashSet::new())
                .unwrap();
        assert_eq!(names(&plan), vec!["not-in-graph"]);
    }

    #[test]
    fn collect_satisfied_includes_installed_registry_entries() {
        // Seed a registry with one managed entry; collect_satisfied must surface it.
        let tmp = std::env::temp_dir().join(format!(
            "wp13_resolve_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut rf = super::super::registry::load(&tmp); // empty/default
        rf.entries.push(super::super::ClaudeStoreEntry {
            kind: "skill".into(),
            name: "groundwork".into(),
            store_path: tmp.join("skills/groundwork").to_string_lossy().into(),
            description: None,
            modified_ms: 0,
            enabled_in: vec![],
            requires: vec![],
            provenance: super::super::RegistryProvenance::local(
                tmp.join("skills/groundwork").to_string_lossy().into(),
            ),
        });
        super::super::registry::save(&tmp, &rf).unwrap();

        let satisfied = collect_satisfied(&tmp, &[]);
        assert!(satisfied.contains(&pref("groundwork")));
        // (external-master union is covered by scan_external_masters' own tests.)
        std::fs::remove_dir_all(&tmp).ok();
    }
}
