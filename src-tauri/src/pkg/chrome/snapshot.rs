//! CDP `Accessibility.getFullAXTree` → `BrowserSnapshot` adapter + stable ref store (WP-05).
//!
//! Owns the **G-SNAPSHOT-ADAPTER** gate. This is the Rust port of the proven
//! spike-S2 mapping (`plans/chrome-pkg/spikes/s2-snapshot-parity/snapshot.mjs`),
//! with the two refinements the spike surfaced folded in (see *Refinements*).
//!
//! ## What it produces
//!
//! From a connected [`chromiumoxide::Page`] it builds a [`BrowserSnapshot`]:
//! top-level `{ id, url, title, text, nodes[] }`, where each node mirrors the
//! contract's `BrowserSnapshotNode` field names (`ref`, `role`, `name`, `value`,
//! `tag`, `checked`, `disabled`, `expanded`, `selected`, `hidden`, `children`).
//! The contract source of truth is `contract/src/browser.ts`; these are the
//! local Rust DTOs that serialize to the same JSON the `engine=webkit` path
//! emits, so `/iyke/browser/*` and the MCP layer see one shape for both engines.
//!
//! Unlike the wire contract (whose `children` is a flat array of child refs), the
//! adapter builds a **nested** tree (`children: Vec<BrowserSnapshotNode>`) — this
//! matches the spike's output and the brief's target node shape, and is the form
//! WP-06/WP-07 flatten or walk as they prefer. See *Tree shape* below.
//!
//! ## The stable ref (gate crux)
//!
//! Every interaction verb (WP-06) targets a `BrowserRef` (`e<N>`). The ref must
//! survive a DOM mutation that happens *between* the snapshot and the action.
//! AX `nodeId`s are NOT stable for that — they're regenerated per AX query. The
//! stable key is **`backendDOMNodeId`** (`backend_dom_node_id`), which CDP
//! guarantees stable for the node's lifetime. So we:
//!
//! 1. assign `e<N>` in traversal order, keyed to `backend_dom_node_id`;
//! 2. record the mapping `e<N> -> backend_dom_node_id` in a [`RefStore`];
//! 3. hand the store back alongside the snapshot.
//!
//! A later action (WP-06) does `RefStore::backend_id("e7") -> 4213i64`, then
//! `DOM.resolveNode { backendNodeId: 4213 } -> RemoteObjectId` (or
//! `DOM.getBoxModel` for a click point / `Input.dispatch*`), all of which accept
//! a backend id directly — so the ref resolves even if the AX tree was rebuilt
//! by an intervening mutation, exactly the G-SNAPSHOT-ADAPTER property.
//!
//! ## Refinements over the raw spike
//!
//! - **`tag` only on element nodes.** `StaticText`/`InlineTextBox` AX nodes carry
//!   no `backend_dom_node_id`, so they get **no ref and no tag** — they aren't
//!   actionable. `tag` is resolved with one `DOM.describeNode(backendNodeId)` per
//!   element node (`Node::local_name`), memoized in a per-snapshot cache.
//! - **`hidden` ≠ AX-`ignored`.** The spike conflated `node.ignored == true`
//!   (an *accessibility-semantics* flag — `html`/`body`/presentational wrappers
//!   are AX-ignored) with *visual* hidden, wrongly marking `html`/`body`
//!   `hidden:true`. Here `hidden` is set **only** from the explicit AX `hidden`
//!   property (`AxPropertyName::Hidden`). AX-ignored wrapper nodes are emitted
//!   normally (they still carry refs/roles), never auto-flagged. `aria-hidden`
//!   subtrees are *pruned by Chrome from `getFullAXTree`* (they don't appear in
//!   `nodes` at all), so the omit-vs-flag decision is **omit** — matching the
//!   contract note ("aria-hidden elements are pruned") and `browser_inject.js`
//!   default (`all=false`). The `all=true` / show-hidden path is a WP-06 filter
//!   concern layered on top of this raw tree, not this adapter's job.
//!
//! ## Module status
//!
//! Unconsumed until WP-06 (actions) wires it into the engine-chrome handlers, so
//! the whole module is `#[allow(dead_code)]` to keep crate warnings at 0.

#![allow(dead_code)]

use std::collections::HashMap;

use anyhow::{Context, Result};
use chromiumoxide::cdp::browser_protocol::accessibility::{AxNode, GetFullAxTreeParams};
use chromiumoxide::cdp::browser_protocol::dom::{BackendNodeId, DescribeNodeParams};
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use chromiumoxide::Page;
use serde::Serialize;

/// Cap on `text` (the plaintext `document.body.innerText`) so a giant page can't
/// balloon the snapshot payload. Mirrors a conservative slice; WP-06 can widen.
const TEXT_CAP: usize = 200_000;

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — local Rust mirror of contract/src/browser.ts (BrowserSnapshot*).
// ─────────────────────────────────────────────────────────────────────────────

/// One accessibility node, mirroring the contract `BrowserSnapshotNode` field
/// names. `ref`/`tag` are `Option` because text-run nodes have neither. All the
/// boolean state fields are `Option<bool>` and serialize-skip when absent so the
/// JSON matches the WebKit path (which only sets a field when it's truthy).
///
/// `children` is **nested** here (not a flat ref array like the wire contract);
/// see the module-level *Tree shape* note.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BrowserSnapshotNode {
    /// Stable element ref (`e<N>`). Absent on text-run nodes (no backend id).
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    /// ARIA role (`button`, `textbox`, `StaticText`, …). Empty string if the AX
    /// node carried no role value (kept non-optional to match the contract,
    /// which has `role: z.string()` required).
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Lowercased element tag (`div`, `input`). Element nodes only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    /// Direct children in document order. Empty on leaves.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<BrowserSnapshotNode>,
}

/// Top-level snapshot mirroring the contract `BrowserSnapshot`. `id`/`snapshot_id`
/// are assigned by the caller (the MCP pane allocator owns `bN` ids + the
/// monotonic snapshot counter); the adapter fills `url`/`title`/`text`/`nodes`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BrowserSnapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    /// Root-first node list. (Single root for a document; a `Vec` to match the
    /// contract's `nodes: BrowserSnapshotNode[]` and allow multi-root edge cases.)
    pub nodes: Vec<BrowserSnapshotNode>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Ref store — the G-SNAPSHOT-ADAPTER artifact.
// ─────────────────────────────────────────────────────────────────────────────

/// Maps the opaque `e<N>` refs handed to agents back to the CDP
/// `backendDOMNodeId` they were keyed to. A WP-06 action resolves a ref through
/// this store, then drives CDP with the backend id (`DOM.resolveNode`,
/// `DOM.getBoxModel`, `Input.dispatch*`), which survives DOM mutation between
/// snapshot and action.
///
/// Lifetime model: one store per `take_snapshot` call. The MCP pane keeps the
/// store from the *latest* snapshot; taking a new snapshot replaces it (the
/// contract's "refs invalidate on the next snapshot" rule). A backend id is
/// assigned exactly one `e<N>` within a snapshot (deduped on first sight in
/// traversal order), so the same DOM node has a stable ref across the tree.
#[derive(Debug, Default, Clone)]
pub struct RefStore {
    /// `e<N>` → `backendDOMNodeId`. The resolution direction WP-06 needs.
    by_ref: HashMap<String, i64>,
    /// `backendDOMNodeId` → `e<N>`. Dedup so one DOM node yields one ref.
    by_backend: HashMap<i64, String>,
    /// Monotonic ref counter (`e1`, `e2`, …; matches the spike's `++n`).
    next: u64,
}

impl RefStore {
    fn new() -> Self {
        Self::default()
    }

    /// Return the existing ref for this backend id, or mint the next `e<N>`.
    /// `None` backend id (text-run nodes) yields no ref.
    fn ref_for(&mut self, backend: Option<i64>) -> Option<String> {
        let backend = backend?;
        if let Some(existing) = self.by_backend.get(&backend) {
            return Some(existing.clone());
        }
        self.next += 1;
        let r = format!("e{}", self.next);
        self.by_ref.insert(r.clone(), backend);
        self.by_backend.insert(backend, r.clone());
        Some(r)
    }

    /// Resolve a ref to its backend node id (the WP-06 entry point).
    pub fn backend_id(&self, ref_: &str) -> Option<i64> {
        self.by_ref.get(ref_).copied()
    }

    /// Reverse lookup: the ref currently assigned to a backend id, if any.
    pub fn ref_of(&self, backend: i64) -> Option<&str> {
        self.by_backend.get(&backend).map(String::as_str)
    }

    /// Number of refs assigned (== distinct element nodes seen).
    pub fn len(&self) -> usize {
        self.by_ref.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_ref.is_empty()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point.
// ─────────────────────────────────────────────────────────────────────────────

/// Snapshot a page: `Accessibility.getFullAXTree` → [`BrowserSnapshot`] plus the
/// [`RefStore`] WP-06 resolves actions against.
///
/// The caller supplies the [`Page`] (obtained via `browser.pages()` /
/// `browser.new_page(..)` in WP-06) so this adapter stays decoupled from page
/// lifecycle/acquisition. Top-level `url`/`title`/`text` come from
/// `Runtime.evaluate` (mirrors the spike; `page.url()/get_title()` would also
/// work but evaluate keeps a single code path and matches the WebKit injector's
/// `document.title`/`location.href`/`document.body.innerText` reads).
pub async fn take_snapshot(page: &Page) -> Result<(BrowserSnapshot, RefStore)> {
    // Top-level fields (string-valued JS expressions → return_by_value).
    let url = eval_string(page, "location.href").await.unwrap_or_default();
    let title = eval_string(page, "document.title").await.unwrap_or_default();
    let mut text = eval_string(page, "document.body ? document.body.innerText : ''")
        .await
        .unwrap_or_default();
    if text.len() > TEXT_CAP {
        text.truncate(TEXT_CAP);
    }

    // Full AX tree.
    let ax = page
        .execute(GetFullAxTreeParams::default())
        .await
        .context("Accessibility.getFullAXTree")?;
    let nodes: &[AxNode] = &ax.result.nodes;

    // Index by AX nodeId for childIds traversal.
    let by_id: HashMap<&str, &AxNode> = nodes
        .iter()
        .map(|n| (n.node_id.as_ref(), n))
        .collect();

    let mut store = RefStore::new();
    let mut tag_cache: HashMap<i64, Option<String>> = HashMap::new();

    // Root = the node with no parentId (matches the spike's `!x.parentId`);
    // fall back to the first node if every node has a parent (shouldn't happen).
    let root = nodes
        .iter()
        .find(|n| n.parent_id.is_none())
        .or_else(|| nodes.first());

    let mut roots = Vec::new();
    if let Some(root) = root {
        let mapped = map_node(page, root, &by_id, &mut store, &mut tag_cache).await?;
        roots.push(mapped);
    }

    Ok((
        BrowserSnapshot {
            url,
            title,
            text,
            nodes: roots,
        },
        store,
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping internals.
// ─────────────────────────────────────────────────────────────────────────────

/// Map one AX node (and, recursively, its children) to a [`BrowserSnapshotNode`].
///
/// `Box::pin` because this is an `async fn` that recurses — Rust needs the future
/// boxed to give it a known size.
fn map_node<'a>(
    page: &'a Page,
    ax: &'a AxNode,
    by_id: &'a HashMap<&'a str, &'a AxNode>,
    store: &'a mut RefStore,
    tag_cache: &'a mut HashMap<i64, Option<String>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<BrowserSnapshotNode>> + Send + 'a>> {
    Box::pin(async move {
        let backend: Option<i64> = ax.backend_dom_node_id.as_ref().map(|b| *b.inner());

        let ref_ = store.ref_for(backend);
        // tag only for element nodes (those with a backend id).
        let tag = match backend {
            Some(b) => tag_for(page, b, tag_cache).await,
            None => None,
        };

        let mut out = BrowserSnapshotNode {
            ref_,
            role: ax_string(ax.role.as_ref()).unwrap_or_default(),
            name: ax_string(ax.name.as_ref()),
            value: ax_string(ax.value.as_ref()),
            tag,
            checked: prop_bool(ax, "checked"),
            disabled: prop_bool(ax, "disabled"),
            expanded: prop_bool(ax, "expanded"),
            selected: prop_bool(ax, "selected"),
            // hidden ONLY from the explicit AX `hidden` property — never from
            // `ignored` (that's AX-semantics, not visual; see module docs).
            hidden: prop_bool(ax, "hidden"),
            children: Vec::new(),
        };

        if let Some(child_ids) = ax.child_ids.as_ref() {
            for cid in child_ids {
                if let Some(child) = by_id.get(cid.as_ref()) {
                    let mapped = map_node(page, child, by_id, store, tag_cache).await?;
                    out.children.push(mapped);
                }
            }
        }

        Ok(out)
    })
}

/// Resolve and memoize an element's lowercased tag via `DOM.describeNode`.
/// A describe failure (detached node, etc.) yields `None` rather than erroring
/// the whole snapshot — a missing tag is a debugging nicety, not load-bearing.
async fn tag_for(
    page: &Page,
    backend: i64,
    cache: &mut HashMap<i64, Option<String>>,
) -> Option<String> {
    if let Some(hit) = cache.get(&backend) {
        return hit.clone();
    }
    let params = DescribeNodeParams::builder()
        .backend_node_id(BackendNodeId::new(backend))
        .build();
    let resolved = match page.execute(params).await {
        Ok(resp) => {
            let name = resp.result.node.local_name.to_ascii_lowercase();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        }
        Err(_) => None,
    };
    cache.insert(backend, resolved.clone());
    resolved
}

/// Evaluate a string-valued JS expression and pull the string out.
/// `return_by_value` so the result comes back as a JSON value, not a remote
/// object handle. Non-string / undefined results yield `None`.
async fn eval_string(page: &Page, expr: &str) -> Option<String> {
    let params = EvaluateParams::builder()
        .expression(expr.to_string())
        .return_by_value(true)
        .build()
        .ok()?;
    let resp = page.execute(params).await.ok()?;
    resp.result.result.value.as_ref().and_then(json_string)
}

// ── Pure helpers (unit-tested below) ─────────────────────────────────────────

/// Extract the string payload of an `AxValue`'s `value` (a `serde_json::Value`).
/// Role/name/value are string-typed AX values; a non-string or absent value
/// yields `None`, and an empty string yields `None` too (matches the spike's
/// `out[k] !== '' ` coverage gate — an empty name is treated as absent).
fn ax_string(v: Option<&chromiumoxide::cdp::browser_protocol::accessibility::AxValue>) -> Option<String> {
    let s = v?.value.as_ref().and_then(json_string)?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Pull a boolean state property (`checked`/`disabled`/`expanded`/`selected`/
/// `hidden`) off an AX node's `properties[]`. Returns `Some(true)`/`Some(false)`
/// when present and boolean, `None` when the property is absent. We surface
/// `Some(false)` faithfully; the serializer's `skip_serializing_if` keeps
/// `false` off the wire only if the caller chooses an `Option`-skipping field —
/// here we keep explicit `false` so WP-06 can distinguish "present and false"
/// from "absent". (The contract treats absent as falsey, so this is a superset.)
fn prop_bool(ax: &AxNode, name: &str) -> Option<bool> {
    let props = ax.properties.as_ref()?;
    for p in props {
        if ax_property_name(&p.name) == name {
            return p.value.value.as_ref().and_then(json_bool);
        }
    }
    None
}

/// Stringify an `AxPropertyName` to its CDP wire name (`checked`, `disabled`, …)
/// by serializing it (the enum carries `#[serde(rename = ...)]` on each variant).
/// Falls back to an empty string on the (impossible) serialize failure.
fn ax_property_name(
    name: &chromiumoxide::cdp::browser_protocol::accessibility::AxPropertyName,
) -> String {
    serde_json::to_value(name)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// `serde_json::Value` → owned `String` iff it's a JSON string.
fn json_string(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// `serde_json::Value` → `bool` iff it's a JSON bool. CDP AX boolean props come
/// across as real JSON booleans (not the string "true"), so a strict `as_bool`
/// is correct; a stray string value yields `None`.
fn json_bool(v: &serde_json::Value) -> Option<bool> {
    v.as_bool()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — pure, on in-memory AX fixtures. No Chrome, no CDP, no async runtime.
//
// These cover the three properties the gate cares about:
//   1. property extraction (role/name/value strings + boolean props),
//   2. the ref is keyed to backendDOMNodeId (stable + deduped),
//   3. hidden/ignored disambiguation (ignored wrapper NOT flagged hidden).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chromiumoxide::cdp::browser_protocol::accessibility::{
        AxNode, AxProperty, AxPropertyName, AxValue, AxValueType,
    };
    use chromiumoxide::cdp::browser_protocol::dom::BackendNodeId;
    use serde_json::json;

    // ── tiny AX-node builders (the parts our mapper reads) ───────────────────

    /// A string-valued AxValue (role/name/value).
    fn ax_str(s: &str) -> AxValue {
        AxValue {
            r#type: AxValueType::String,
            value: Some(json!(s)),
            related_nodes: None,
            sources: None,
        }
    }

    /// A boolean-valued AxValue (property payloads).
    fn ax_bool(b: bool) -> AxValue {
        AxValue {
            r#type: AxValueType::Boolean,
            value: Some(json!(b)),
            related_nodes: None,
            sources: None,
        }
    }

    fn prop(name: AxPropertyName, b: bool) -> AxProperty {
        AxProperty {
            name,
            value: ax_bool(b),
        }
    }

    /// An element AX node: has a backend id (so it earns a ref).
    fn element_node(id: &str, backend: i64, role: &str) -> AxNode {
        AxNode {
            node_id: id.to_string().into(),
            ignored: false,
            ignored_reasons: None,
            role: Some(ax_str(role)),
            chrome_role: None,
            name: None,
            description: None,
            value: None,
            properties: None,
            parent_id: None,
            child_ids: None,
            backend_dom_node_id: Some(BackendNodeId::new(backend)),
            frame_id: None,
        }
    }

    // ── 1. property extraction ───────────────────────────────────────────────

    #[test]
    fn ax_string_extracts_and_treats_empty_as_absent() {
        assert_eq!(ax_string(Some(&ax_str("Submit"))), Some("Submit".to_string()));
        assert_eq!(ax_string(Some(&ax_str(""))), None);
        assert_eq!(ax_string(None), None);
        // a non-string AxValue (boolean) is not a string → None
        assert_eq!(ax_string(Some(&ax_bool(true))), None);
    }

    #[test]
    fn prop_bool_reads_named_boolean_property() {
        let mut node = element_node("n1", 10, "checkbox");
        node.properties = Some(vec![
            prop(AxPropertyName::Checked, true),
            prop(AxPropertyName::Disabled, false),
        ]);
        assert_eq!(prop_bool(&node, "checked"), Some(true));
        assert_eq!(prop_bool(&node, "disabled"), Some(false));
        // absent property → None (not Some(false))
        assert_eq!(prop_bool(&node, "expanded"), None);
        assert_eq!(prop_bool(&node, "selected"), None);
    }

    #[test]
    fn ax_property_name_serializes_to_wire_name() {
        assert_eq!(ax_property_name(&AxPropertyName::Checked), "checked");
        assert_eq!(ax_property_name(&AxPropertyName::Disabled), "disabled");
        assert_eq!(ax_property_name(&AxPropertyName::Expanded), "expanded");
        assert_eq!(ax_property_name(&AxPropertyName::Selected), "selected");
        assert_eq!(ax_property_name(&AxPropertyName::Hidden), "hidden");
    }

    // ── 2. ref keyed to backendDOMNodeId (stable + deduped) ──────────────────

    #[test]
    fn ref_is_keyed_to_backend_id_and_resolves_back() {
        let mut store = RefStore::new();
        let r = store.ref_for(Some(4213)).expect("element gets a ref");
        assert_eq!(r, "e1");
        // the gate property: e-ref resolves back to the backend id WP-06 drives.
        assert_eq!(store.backend_id("e1"), Some(4213));
        assert_eq!(store.ref_of(4213), Some("e1"));
    }

    #[test]
    fn same_backend_id_dedupes_to_one_ref() {
        let mut store = RefStore::new();
        let a = store.ref_for(Some(7));
        let b = store.ref_for(Some(7)); // same DOM node, seen twice
        assert_eq!(a, b, "one DOM node must map to one stable ref");
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn distinct_backend_ids_get_distinct_increasing_refs() {
        let mut store = RefStore::new();
        assert_eq!(store.ref_for(Some(1)), Some("e1".to_string()));
        assert_eq!(store.ref_for(Some(2)), Some("e2".to_string()));
        assert_eq!(store.ref_for(Some(3)), Some("e3".to_string()));
    }

    #[test]
    fn text_run_node_without_backend_id_gets_no_ref() {
        let mut store = RefStore::new();
        // StaticText / InlineTextBox carry no backendDOMNodeId.
        assert_eq!(store.ref_for(None), None);
        assert!(store.is_empty(), "a text run must not consume a ref slot");
    }

    // ── 3. hidden / ignored disambiguation ───────────────────────────────────

    #[test]
    fn ignored_wrapper_is_not_flagged_hidden() {
        // An AX-ignored wrapper (html/body/presentational): ignored=true but NO
        // explicit `hidden` property. The spike wrongly flagged these hidden;
        // we must not.
        let mut wrapper = element_node("body", 2, "none");
        wrapper.ignored = true;
        wrapper.properties = None;
        assert_eq!(
            prop_bool(&wrapper, "hidden"),
            None,
            "AX-ignored wrapper must not be reported as visually hidden"
        );
    }

    #[test]
    fn explicit_hidden_property_is_flagged() {
        // A node Chrome marked with the explicit AX `hidden` property IS hidden.
        let mut node = element_node("n9", 99, "button");
        node.properties = Some(vec![prop(AxPropertyName::Hidden, true)]);
        assert_eq!(prop_bool(&node, "hidden"), Some(true));
    }

    // ── json coercion helpers ────────────────────────────────────────────────

    #[test]
    fn json_coercions_are_strict() {
        assert_eq!(json_string(&json!("x")), Some("x".to_string()));
        assert_eq!(json_string(&json!(5)), None);
        assert_eq!(json_bool(&json!(true)), Some(true));
        assert_eq!(json_bool(&json!("true")), None); // a string is not a bool
        assert_eq!(json_bool(&json!(1)), None);
    }
}
