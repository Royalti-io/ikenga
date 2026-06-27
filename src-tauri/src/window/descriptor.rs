//! `WindowDescriptor` — the Rust source-of-truth mirrored by the TS Zod schema
//! in `@ikenga/contract` at `src/window.ts`. Field changes MUST be made in
//! lockstep with the TS schema (the `window.test.ts` + the test below assert the
//! same canonical wire fixtures).
//!
//! Half of the `G-WINDOW-MODEL` freeze gate (plans/multi-window WP-02); the
//! other half is `events.rs`.

use serde::{Deserialize, Serialize};

/// What a window is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowKind {
    /// The original "main" window (full chrome).
    Primary,
    /// A thin detached window hosting one surface (Flavor C).
    SingleSurface,
    /// A torn-off pane group (Flavor A, Phase 2).
    PaneSet,
    /// A second full workspace window (Flavor B, Phase 3).
    Workspace,
}

/// The Rust↔FE window contract. Mirrors `WindowDescriptorSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowDescriptor {
    /// OS window label. "main" for the primary; "detached-<n>" otherwise.
    pub label: String,
    pub kind: WindowKind,
    /// Surface/route ids the window's FE entry mounts.
    #[serde(default)]
    pub surface_set: Vec<String>,
    /// Project this window is bound to (Flavor B); `None` follows primary.
    #[serde(default)]
    pub project_id: Option<String>,
    /// SQLite `layout_state` key-string partition (folded into `scopedKey()`,
    /// NOT a column — G-03). Usually equals `label`.
    pub layout_key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The SAME canonical fixture as contract/src/window.test.ts.
    const DESCRIPTOR_JSON: &str = r#"{
        "label": "detached-1",
        "kind": "single-surface",
        "surface_set": ["chat"],
        "project_id": null,
        "layout_key": "detached-1"
    }"#;

    #[test]
    fn descriptor_round_trips_the_canonical_fixture() {
        let d: WindowDescriptor = serde_json::from_str(DESCRIPTOR_JSON).unwrap();
        assert_eq!(d.label, "detached-1");
        assert_eq!(d.kind, WindowKind::SingleSurface);
        assert_eq!(d.surface_set, vec!["chat".to_string()]);
        assert_eq!(d.project_id, None);
        // re-serialize and re-parse: wire shape is stable
        let s = serde_json::to_string(&d).unwrap();
        let d2: WindowDescriptor = serde_json::from_str(&s).unwrap();
        assert_eq!(d, d2);
    }

    #[test]
    fn kind_serializes_kebab_case_matching_ts() {
        let s = serde_json::to_string(&WindowKind::SingleSurface).unwrap();
        assert_eq!(s, "\"single-surface\"");
    }

    #[test]
    fn unknown_field_is_rejected() {
        let bad = r#"{"label":"x","kind":"primary","layout_key":"x","rogue":true}"#;
        assert!(serde_json::from_str::<WindowDescriptor>(bad).is_err());
    }

    #[test]
    fn defaults_apply_for_surface_set_and_project_id() {
        let d: WindowDescriptor =
            serde_json::from_str(r#"{"label":"main","kind":"primary","layout_key":"main"}"#)
                .unwrap();
        assert!(d.surface_set.is_empty());
        assert_eq!(d.project_id, None);
    }
}
