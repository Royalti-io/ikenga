//! `engine = "chrome"` action verbs over CDP (WP-06).
//!
//! These are the Managed-Chrome counterpart to the WebKit `__ipb.*` injected
//! verbs in [`crate::iyke::browser_handlers`]. Where the WebKit engine evals a
//! closure into the child webview, here we drive the page over the Chrome
//! DevTools Protocol via [`chromiumoxide`], resolving element targets through
//! the WP-05 [`RefStore`] (`e<N>` → `backendDOMNodeId`).
//!
//! ## The ref → node resolution chain
//!
//! Every element-targeting verb (`click`/`fill`/`select`/`press_key`) takes a
//! [`BrowserRef`]-style `e<N>` string. The chain is:
//!
//! ```text
//! "e7"  --RefStore::backend_id-->  4213 (backendDOMNodeId)
//!        ├─ DOM.getBoxModel { backendNodeId } -> Quad -> click point (x,y)
//!        ├─ DOM.focus       { backendNodeId } -> caret in the field
//!        └─ DOM.resolveNode { backendNodeId } -> RemoteObjectId (for eval-on-node)
//! ```
//!
//! `backendDOMNodeId` is stable for the node's lifetime, so a ref resolves even
//! if the AX tree was rebuilt by a DOM mutation between snapshot and action —
//! the G-SNAPSHOT-ADAPTER property WP-05 proved. We deliberately drive at the
//! **backend-node** level (not `nodeId`, which is per-`DOM.getDocument` and goes
//! stale) so we never need to re-walk the document.
//!
//! ## Per-engine verb matrix (G-05)
//!
//! Managed Chrome is an external OS window, not a shell pane. So, relative to
//! the pane-shaped `/iyke/browser/*` contract:
//!
//! | verb         | engine=chrome behaviour                                   |
//! |--------------|-----------------------------------------------------------|
//! | goto/back/forward/reload | full support (Page.navigate / history)        |
//! | click        | `DOM.getBoxModel` centre → `Input.dispatchMouseEvent`      |
//! | fill         | `DOM.focus` (+ optional select-all clear) → `Input.insertText` |
//! | select       | `DOM.resolveNode` → `Runtime.callFunctionOn` set-`<option>` (no native CDP verb) |
//! | press_key    | `Input.dispatchKeyEvent` (US-layout key map + modifier bits) |
//! | eval         | `Runtime.evaluate` of `(() => {{ <script> }})()` — IIFE parity with WebKit (script must `return`) |
//! | screenshot   | `Page.captureScreenshot` → base64 PNG (FIRST engine to satisfy `/screenshot`) |
//! | wait_for     | poll `location.href` / re-snapshot until predicate or timeout |
//! | focus (pane) | **caller maps to** [`bring_to_front`] = `Page.bringToFront` (NOT shell-pane focus) |
//! | rect / set_rect | the routing layer (WP-07) ignores these for chrome; this module exposes no rect verb |
//!
//! ### Verbs that cannot be supported faithfully over CDP
//!
//! - **`select` by visible-label only** — CDP has no "pick option" primitive, so
//!   we set `<select>.value` + dispatch `input`/`change` via `Runtime`. We match
//!   on the option `value` first, then visible label (mirroring the contract's
//!   "value attribute (preferred) or visible label"). A `<select>` that isn't a
//!   real `HTMLSelectElement` (e.g. an ARIA listbox) is rejected — the WebKit
//!   path has the same limitation.
//! - **`click` on an off-screen node** — `DOM.getBoxModel` errors for a node with
//!   no layout box (display:none / detached). We surface that as an error rather
//!   than silently scrolling; a real `scrollIntoViewIfNeeded` pass is a WP-07+
//!   nicety (the WebKit injector scrolls; parity TODO noted in code).
//!
//! ## Module status
//!
//! Unconsumed until WP-07 routes `/iyke/browser/*` `engine=chrome` here, so the
//! whole module is `#[allow(dead_code)]` to keep crate warnings at 0. The pure
//! helpers (key mapping, modifier parsing, combo splitting, box-centre) are
//! unit-tested below with no Chrome / CDP / async runtime.

#![allow(dead_code)]

use anyhow::{anyhow, bail, Context, Result};
use chromiumoxide::cdp::browser_protocol::dom::{
    BackendNodeId, FocusParams, GetBoxModelParams, ResolveNodeParams,
};
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    InsertTextParams, MouseButton,
};
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, GetNavigationHistoryParams,
    NavigateParams, NavigateToHistoryEntryParams,
};
use chromiumoxide::cdp::js_protocol::runtime::{CallFunctionOnParams, EvaluateParams};
use chromiumoxide::Page;
use serde_json::Value;

use super::snapshot::RefStore;

/// Default per-action timeout (matches the WebKit `INTERACTION_TIMEOUT`).
const ACTION_TIMEOUT_MS: u64 = 10_000;
/// `wait_for` default + clamp bounds, mirroring `BrowserWaitForInputSchema`.
const WAIT_DEFAULT_MS: u64 = 10_000;
const WAIT_MIN_MS: u64 = 100;
const WAIT_MAX_MS: u64 = 60_000;
/// Poll cadence while a `wait_for` predicate is unsatisfied.
const WAIT_POLL_MS: u64 = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Navigation verbs.
// ─────────────────────────────────────────────────────────────────────────────

/// `goto` — navigate the page and return the resulting URL.
pub async fn goto(page: &Page, url: &str) -> Result<String> {
    page.execute(NavigateParams::new(url.to_string()))
        .await
        .with_context(|| format!("Page.navigate({url})"))?;
    Ok(current_url(page).await)
}

/// `back` — step one entry backwards in the page's navigation history.
/// No-ops (and reports the current URL) if there is nothing to go back to.
pub async fn back(page: &Page) -> Result<String> {
    history_step(page, -1).await
}

/// `forward` — step one entry forwards in the page's navigation history.
pub async fn forward(page: &Page) -> Result<String> {
    history_step(page, 1).await
}

/// `reload` — reload the current page.
pub async fn reload(page: &Page) -> Result<String> {
    page.reload().await.context("Page.reload")?;
    Ok(current_url(page).await)
}

/// Shared back/forward implementation. CDP exposes no `Page.goBack`; instead we
/// read the history list, find the current index, and navigate to the entry at
/// `current + delta` (clamped to the valid range — a no-op at the ends).
async fn history_step(page: &Page, delta: i64) -> Result<String> {
    let hist = page
        .execute(GetNavigationHistoryParams::default())
        .await
        .context("Page.getNavigationHistory")?;
    let entries = &hist.result.entries;
    let cur = hist.result.current_index;
    let target = cur + delta;
    if target < 0 || target as usize >= entries.len() {
        // At the edge of history — nothing to do, report where we are.
        return Ok(current_url(page).await);
    }
    let entry_id = entries[target as usize].id;
    page.execute(NavigateToHistoryEntryParams::new(entry_id))
        .await
        .context("Page.navigateToHistoryEntry")?;
    Ok(current_url(page).await)
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction verbs.
// ─────────────────────────────────────────────────────────────────────────────

/// `click` — resolve `e_ref` to a backend node, compute the centre of its box
/// model, and dispatch a press+release mouse event there. Returns the URL after
/// the click (a click may navigate).
pub async fn click(page: &Page, store: &RefStore, e_ref: &str) -> Result<String> {
    let backend = resolve_ref(store, e_ref)?;
    let (x, y) = box_center(page, backend).await?;

    // mousePressed → mouseReleased at the same point, button=left, clickCount=1.
    let press = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MousePressed)
        .x(x)
        .y(y)
        .button(MouseButton::Left)
        .click_count(1)
        .build()
        .map_err(|e| anyhow!("build mousePressed: {e}"))?;
    page.execute(press)
        .await
        .context("Input.dispatchMouseEvent(mousePressed)")?;

    let release = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseReleased)
        .x(x)
        .y(y)
        .button(MouseButton::Left)
        .click_count(1)
        .build()
        .map_err(|e| anyhow!("build mouseReleased: {e}"))?;
    page.execute(release)
        .await
        .context("Input.dispatchMouseEvent(mouseReleased)")?;

    Ok(current_url(page).await)
}

/// `fill` — focus the resolved node and type `text`. When `replace` is set we
/// first select-all + delete the existing value (CDP has no atomic "set value",
/// so we focus → `Ctrl+A` → `Delete` → insertText). `insertText` fires the same
/// `input` event a real keystroke would, so React/Vue controlled inputs update.
pub async fn fill(page: &Page, store: &RefStore, e_ref: &str, text: &str, replace: bool) -> Result<()> {
    let backend = resolve_ref(store, e_ref)?;
    focus_backend(page, backend).await?;

    if replace {
        // Select-all then delete. We dispatch the key chords rather than eval so
        // the field's own keydown handlers see them (parity with a human).
        for combo in ["Ctrl+a", "Delete"] {
            dispatch_combo(page, combo).await?;
        }
    }

    page.execute(InsertTextParams::new(text.to_string()))
        .await
        .context("Input.insertText")?;
    Ok(())
}

/// `select` — set the value of a `<select>`. CDP has no option-pick primitive,
/// so we resolve the node to a `RemoteObjectId` and run a small function on it
/// that matches `value` against each option's `value` (preferred) then its
/// visible label, sets `selectedIndex`, and dispatches `input`+`change`.
/// Returns an error if the node isn't an `HTMLSelectElement` or no option matched.
pub async fn select(page: &Page, store: &RefStore, e_ref: &str, value: &str) -> Result<()> {
    let backend = resolve_ref(store, e_ref)?;
    let object_id = resolve_object_id(page, backend).await?;

    // `function(value){ ... }` run with `this` = the resolved <select>.
    const SET_OPTION: &str = r#"
function(wanted) {
  if (!(this instanceof HTMLSelectElement)) {
    return { ok: false, reason: 'not-a-select' };
  }
  const opts = Array.from(this.options);
  let idx = opts.findIndex(o => o.value === wanted);
  if (idx < 0) idx = opts.findIndex(o => (o.label || o.textContent || '').trim() === wanted);
  if (idx < 0) return { ok: false, reason: 'no-matching-option' };
  this.selectedIndex = idx;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}
"#;

    let call = CallFunctionOnParams::builder()
        .object_id(object_id)
        .function_declaration(SET_OPTION.to_string())
        .argument(
            chromiumoxide::cdp::js_protocol::runtime::CallArgument::builder()
                .value(Value::String(value.to_string()))
                .build(),
        )
        .return_by_value(true)
        .build()
        .map_err(|e| anyhow!("build Runtime.callFunctionOn(select): {e}"))?;

    let resp = page
        .execute(call)
        .await
        .context("Runtime.callFunctionOn(select)")?;
    let result = resp.result.result.value.clone().unwrap_or(Value::Null);
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        let reason = result
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        bail!("select failed: {reason}")
    }
}

/// `press_key` — dispatch a key combo (e.g. `"Enter"`, `"Ctrl+S"`, `"Shift+Tab"`)
/// to the page. If `e_ref` is given we focus that node first; otherwise the combo
/// goes to whatever currently has focus (matching the WebKit verb's optional ref).
pub async fn press_key(page: &Page, store: &RefStore, e_ref: Option<&str>, combo: &str) -> Result<()> {
    if let Some(r) = e_ref {
        let backend = resolve_ref(store, r)?;
        focus_backend(page, backend).await?;
    }
    dispatch_combo(page, combo).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspection / escape-hatch verbs.
// ─────────────────────────────────────────────────────────────────────────────

/// `eval` — run an arbitrary JS *function body* in the page and return the JSON
/// value (`Value::Null` for `undefined`/non-serializable results).
///
/// The script is wrapped in an IIFE so it must `return` to produce a value —
/// byte-identical semantics to the WebKit eval path
/// (`(() => {{ {} }})()` in `crate::iyke::browser_handlers::post_browser_eval`),
/// so the *same* `browser_eval` script works on both engines. Without the
/// wrapper, CDP `Runtime.evaluate` treats `script` as a bare expression and a
/// top-level `return` is a SyntaxError → `null`, silently diverging from the
/// documented `browser_eval` contract. `return_by_value` gives us the value
/// inline (not a remote handle); `await_promise` preserves the "or a Promise
/// resolving to one" behavior the WebKit path also allows.
pub async fn eval(page: &Page, script: &str) -> Result<Value> {
    let wrapped = format!("(() => {{ {script} }})()");
    let params = EvaluateParams::builder()
        .expression(wrapped)
        .return_by_value(true)
        .await_promise(true)
        .build()
        .map_err(|e| anyhow!("build Runtime.evaluate: {e}"))?;
    let resp = page.execute(params).await.context("Runtime.evaluate")?;
    Ok(resp.result.result.value.clone().unwrap_or(Value::Null))
}

/// A captured screenshot: base64 PNG plus its pixel dimensions (read back from
/// the page so the caller can fill `BrowserScreenshotResult.{width,height}`).
pub struct Screenshot {
    /// Base64-encoded PNG (CDP returns it already base64'd).
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// `screenshot` — `Page.captureScreenshot` (PNG, from-surface). This is the
/// first engine to satisfy `/screenshot` (the WebKit kernel still 501s it).
/// Dimensions are read via `window.inner{Width,Height}` × devicePixelRatio so
/// the result mirrors the captured surface.
pub async fn screenshot(page: &Page) -> Result<Screenshot> {
    let params = CaptureScreenshotParams::builder()
        .format(CaptureScreenshotFormat::Png)
        .from_surface(true)
        .build();
    let resp = page
        .execute(params)
        .await
        .context("Page.captureScreenshot")?;
    // `Binary` derefs to the base64 string already.
    let base64: String = AsRef::<str>::as_ref(&resp.result.data).to_string();

    let (width, height) = screenshot_dims(page).await.unwrap_or((0, 0));
    Ok(Screenshot {
        base64,
        width,
        height,
    })
}

/// What a `wait_for` predicate is checking. Mirrors the contract's
/// `BROWSER_WAIT_FOR_KINDS`, minus the snapshot-dependent kinds the routing
/// layer (WP-07) folds into `text`/`ref` by re-snapshotting — those are passed
/// through to [`WaitFor::Ref`] / [`WaitFor::Text`] with the freshly-rendered text.
pub enum WaitFor {
    /// Substring match against `location.href`.
    Url(String),
    /// Substring match against the page's rendered `document.body.innerText`.
    Text(String),
    /// The substring is *absent* from the rendered text.
    GoneText(String),
    /// A `querySelector(selector)` returns a node.
    Selector(String),
    /// A `querySelector(selector)` returns null.
    GoneSelector(String),
    /// `document.readyState === 'complete'` (a coarse idle proxy).
    Idle,
}

/// The outcome of a `wait_for` poll, mirroring `BrowserWaitForResult`.
pub struct WaitOutcome {
    pub satisfied: bool,
    pub elapsed_ms: u64,
}

/// `wait_for` — poll the predicate every [`WAIT_POLL_MS`] until satisfied or the
/// (clamped) timeout elapses. Each predicate is one cheap `Runtime.evaluate`
/// returning a bool, so we never re-walk the AX tree here. `timeout_ms` is
/// clamped to `[WAIT_MIN_MS, WAIT_MAX_MS]`; `None` uses [`WAIT_DEFAULT_MS`].
pub async fn wait_for(page: &Page, pred: &WaitFor, timeout_ms: Option<u64>) -> Result<WaitOutcome> {
    let budget = timeout_ms
        .unwrap_or(WAIT_DEFAULT_MS)
        .clamp(WAIT_MIN_MS, WAIT_MAX_MS);
    let start = tokio::time::Instant::now();
    let deadline = start + std::time::Duration::from_millis(budget);
    let expr = wait_expr(pred);

    loop {
        // A predicate-eval failure (e.g. mid-navigation) is treated as
        // "not yet satisfied", not a hard error — we keep polling.
        let satisfied = match eval_bool(page, &expr).await {
            Ok(b) => b,
            Err(_) => false,
        };
        if satisfied {
            return Ok(WaitOutcome {
                satisfied: true,
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(WaitOutcome {
                satisfied: false,
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(WAIT_POLL_MS)).await;
    }
}

/// `focus` (pane) → `Page.bringToFront`. Per the G-05 matrix, `engine=chrome`'s
/// `/focus` is a CDP page-foreground, NOT shell-pane focus. Exposed so WP-07 can
/// map the pane verb to it.
pub async fn bring_to_front(page: &Page) -> Result<()> {
    page.bring_to_front()
        .await
        .context("Page.bringToFront")?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP plumbing helpers.
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve an `e<N>` ref to its backend node id via the WP-05 store, erroring
/// with a clear message (not a panic) on an unknown/stale ref.
fn resolve_ref(store: &RefStore, e_ref: &str) -> Result<i64> {
    store
        .backend_id(e_ref)
        .ok_or_else(|| anyhow!("unknown or stale ref {e_ref:?} (re-snapshot to refresh refs)"))
}

/// `DOM.focus { backendNodeId }`.
async fn focus_backend(page: &Page, backend: i64) -> Result<()> {
    let params = FocusParams::builder()
        .backend_node_id(BackendNodeId::new(backend))
        .build();
    page.execute(params).await.context("DOM.focus")?;
    Ok(())
}

/// `DOM.resolveNode { backendNodeId } -> RemoteObjectId` for eval-on-node.
async fn resolve_object_id(
    page: &Page,
    backend: i64,
) -> Result<chromiumoxide::cdp::js_protocol::runtime::RemoteObjectId> {
    let params = ResolveNodeParams::builder()
        .backend_node_id(BackendNodeId::new(backend))
        .build();
    let resp = page.execute(params).await.context("DOM.resolveNode")?;
    resp.result
        .object
        .object_id
        .ok_or_else(|| anyhow!("DOM.resolveNode returned no objectId for backend {backend}"))
}

/// `DOM.getBoxModel { backendNodeId }` → the centre of the content box, in CSS
/// pixels (the coordinate space `Input.dispatchMouseEvent` expects). Errors if
/// the node has no layout box (display:none / detached).
async fn box_center(page: &Page, backend: i64) -> Result<(f64, f64)> {
    let params = GetBoxModelParams::builder()
        .backend_node_id(BackendNodeId::new(backend))
        .build();
    let resp = page
        .execute(params)
        .await
        .context("DOM.getBoxModel (node may be off-screen / display:none)")?;
    quad_center(resp.result.model.content.inner())
        .ok_or_else(|| anyhow!("DOM.getBoxModel content quad had unexpected arity"))
}

/// Read the captured-surface dimensions for the screenshot result.
async fn screenshot_dims(page: &Page) -> Result<(u32, u32)> {
    let v = eval(
        page,
        "[Math.round((window.innerWidth||0)*(window.devicePixelRatio||1)), \
          Math.round((window.innerHeight||0)*(window.devicePixelRatio||1))]",
    )
    .await?;
    let w = v.get(0).and_then(Value::as_u64).unwrap_or(0) as u32;
    let h = v.get(1).and_then(Value::as_u64).unwrap_or(0) as u32;
    Ok((w, h))
}

/// Current `location.href`, best-effort (empty string if the page is mid-tear-down).
async fn current_url(page: &Page) -> String {
    match page.url().await {
        Ok(Some(u)) => u,
        _ => eval_string(page, "location.href").await.unwrap_or_default(),
    }
}

/// Evaluate a string-valued JS expression, pulling the string out.
async fn eval_string(page: &Page, expr: &str) -> Option<String> {
    let v = eval(page, expr).await.ok()?;
    v.as_str().map(str::to_string)
}

/// Evaluate a boolean JS expression (used by `wait_for`).
async fn eval_bool(page: &Page, expr: &str) -> Result<bool> {
    let v = eval(page, expr).await?;
    Ok(v.as_bool().unwrap_or(false))
}

/// Dispatch a full key combo (modifiers held over a single main key). Sends a
/// `keyDown` then `keyUp` for the main key with the modifier bitfield set, after
/// a `keyDown` for each modifier and a `keyUp` for each after — matching how a
/// real chord is delivered.
async fn dispatch_combo(page: &Page, combo: &str) -> Result<()> {
    let parsed = parse_combo(combo).ok_or_else(|| anyhow!("unrecognised key combo {combo:?}"))?;
    let modifiers = parsed.modifier_bits();

    // Press modifier keys first (so the page sees them held).
    for m in &parsed.modifiers {
        let down = key_event(DispatchKeyEventType::KeyDown, m.key_def(), parsed.bits_excluding(*m))?;
        page.execute(down).await.context("Input.dispatchKeyEvent(mod down)")?;
    }

    // Main key down+up with the full modifier set.
    let key = parsed.key;
    let down = key_event_for(DispatchKeyEventType::KeyDown, key, modifiers, parsed.printable_text())?;
    page.execute(down).await.context("Input.dispatchKeyEvent(keyDown)")?;
    let up = key_event_for(DispatchKeyEventType::KeyUp, key, modifiers, None)?;
    page.execute(up).await.context("Input.dispatchKeyEvent(keyUp)")?;

    // Release modifier keys in reverse order.
    for m in parsed.modifiers.iter().rev() {
        let up = key_event(DispatchKeyEventType::KeyUp, m.key_def(), parsed.bits_excluding(*m))?;
        page.execute(up).await.context("Input.dispatchKeyEvent(mod up)")?;
    }
    Ok(())
}

/// Build a key event for a [`KeyDef`].
fn key_event(
    ty: DispatchKeyEventType,
    def: KeyDef,
    modifiers: i64,
) -> Result<DispatchKeyEventParams> {
    key_event_for(ty, def, modifiers, None)
}

/// Build a `DispatchKeyEventParams` from a [`KeyDef`] + modifier bits, optionally
/// with the printable `text` (only meaningful on `keyDown` for a producing key).
fn key_event_for(
    ty: DispatchKeyEventType,
    def: KeyDef,
    modifiers: i64,
    text: Option<String>,
) -> Result<DispatchKeyEventParams> {
    let mut b = DispatchKeyEventParams::builder()
        .r#type(ty)
        .key(def.key.to_string())
        .code(def.code.to_string())
        .windows_virtual_key_code(def.vk)
        .native_virtual_key_code(def.vk);
    if modifiers != 0 {
        b = b.modifiers(modifiers);
    }
    if let Some(t) = text {
        b = b.text(t);
    }
    b.build().map_err(|e| anyhow!("build key event: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — geometry, key mapping, combo parsing (unit-tested below).
// ─────────────────────────────────────────────────────────────────────────────

/// Centre of a CDP `Quad` (8 numbers: x1,y1, x2,y2, x3,y3, x4,y4). Averages the
/// four corners. Returns `None` if the quad doesn't carry the expected 8 values.
fn quad_center(q: &[f64]) -> Option<(f64, f64)> {
    if q.len() < 8 {
        return None;
    }
    let x = (q[0] + q[2] + q[4] + q[6]) / 4.0;
    let y = (q[1] + q[3] + q[5] + q[7]) / 4.0;
    Some((x, y))
}

/// A single physical key's CDP descriptors (the subset `Input.dispatchKeyEvent`
/// needs: `key`, `code`, Windows VK). US layout, the same table Puppeteer ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyDef {
    key: &'static str,
    code: &'static str,
    vk: i64,
}

/// Map a key name (the part after the last `+` in a combo) to its [`KeyDef`].
/// Handles the common named keys plus single printable characters. Returns
/// `None` for anything we can't faithfully synthesize.
fn key_def(name: &str) -> Option<KeyDef> {
    // Named keys (case-insensitive on the spelled-out names).
    let lower = name.to_ascii_lowercase();
    let named = match lower.as_str() {
        "enter" | "return" => Some(KeyDef { key: "Enter", code: "Enter", vk: 13 }),
        "tab" => Some(KeyDef { key: "Tab", code: "Tab", vk: 9 }),
        "escape" | "esc" => Some(KeyDef { key: "Escape", code: "Escape", vk: 27 }),
        "backspace" => Some(KeyDef { key: "Backspace", code: "Backspace", vk: 8 }),
        "delete" | "del" => Some(KeyDef { key: "Delete", code: "Delete", vk: 46 }),
        "space" | " " => Some(KeyDef { key: " ", code: "Space", vk: 32 }),
        "arrowup" | "up" => Some(KeyDef { key: "ArrowUp", code: "ArrowUp", vk: 38 }),
        "arrowdown" | "down" => Some(KeyDef { key: "ArrowDown", code: "ArrowDown", vk: 40 }),
        "arrowleft" | "left" => Some(KeyDef { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }),
        "arrowright" | "right" => Some(KeyDef { key: "ArrowRight", code: "ArrowRight", vk: 39 }),
        "home" => Some(KeyDef { key: "Home", code: "Home", vk: 36 }),
        "end" => Some(KeyDef { key: "End", code: "End", vk: 35 }),
        "pageup" => Some(KeyDef { key: "PageUp", code: "PageUp", vk: 33 }),
        "pagedown" => Some(KeyDef { key: "PageDown", code: "PageDown", vk: 34 }),
        _ => None,
    };
    if named.is_some() {
        return named;
    }

    // Single printable character: letters and digits get a stable code/VK;
    // other printables fall back to a code-less event the page still sees as
    // a character (text is supplied by the caller on keyDown).
    let mut chars = name.chars();
    let (c, rest) = (chars.next(), chars.next());
    if let (Some(c), None) = (c, rest) {
        return Some(printable_key_def(c));
    }
    None
}

/// [`KeyDef`] for a single printable character (US layout). Uppercases letters
/// for the `code`/VK (`KeyA`/65) but keeps the original `key` (`a` vs `A`) — the
/// caller folds shift in via the modifier bits + `text`.
fn printable_key_def(c: char) -> KeyDef {
    let up = c.to_ascii_uppercase();
    if up.is_ascii_alphabetic() {
        // Leak a 1-char &'static str via a small static lookup isn't possible
        // for arbitrary chars; we store the *uppercase* canonical descriptors
        // and let `key` carry the original case through `text`. For the table we
        // use a fixed set built at call-time is impossible (&'static), so we map
        // letters to their canonical static descriptors.
        return LETTER_DEFS[(up as u8 - b'A') as usize];
    }
    if c.is_ascii_digit() {
        return DIGIT_DEFS[(c as u8 - b'0') as usize];
    }
    // Non-alphanumeric printable: no stable code/VK, rely on `text` on keyDown.
    KeyDef { key: PUNCT_PLACEHOLDER, code: "", vk: 0 }
}

/// Placeholder `key` for punctuation we synthesize via `text` only. The real
/// character is delivered through `DispatchKeyEventParams.text`; `key` here is a
/// harmless non-empty marker so the field isn't blank.
const PUNCT_PLACEHOLDER: &str = "Unidentified";

/// A modifier key in a combo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Modifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

impl Modifier {
    /// CDP modifier bit (Alt=1, Ctrl=2, Meta=4, Shift=8).
    fn bit(self) -> i64 {
        match self {
            Modifier::Alt => 1,
            Modifier::Ctrl => 2,
            Modifier::Meta => 4,
            Modifier::Shift => 8,
        }
    }

    /// The modifier's own [`KeyDef`] (for the held-key down/up events).
    fn key_def(self) -> KeyDef {
        match self {
            Modifier::Alt => KeyDef { key: "Alt", code: "AltLeft", vk: 18 },
            Modifier::Ctrl => KeyDef { key: "Control", code: "ControlLeft", vk: 17 },
            Modifier::Meta => KeyDef { key: "Meta", code: "MetaLeft", vk: 91 },
            Modifier::Shift => KeyDef { key: "Shift", code: "ShiftLeft", vk: 16 },
        }
    }

    /// Parse a single modifier token (case-insensitive, with common aliases).
    fn parse(tok: &str) -> Option<Modifier> {
        match tok.to_ascii_lowercase().as_str() {
            "alt" | "option" => Some(Modifier::Alt),
            "ctrl" | "control" => Some(Modifier::Ctrl),
            "meta" | "cmd" | "command" | "super" => Some(Modifier::Meta),
            "shift" => Some(Modifier::Shift),
            _ => None,
        }
    }
}

/// A parsed key combo: zero-or-more modifiers + exactly one main key.
#[derive(Debug, Clone)]
struct Combo {
    modifiers: Vec<Modifier>,
    key: KeyDef,
    /// The original main-key token (used to decide a printable `text`).
    raw_key: String,
}

impl Combo {
    /// Full CDP modifier bitfield.
    fn modifier_bits(&self) -> i64 {
        self.modifiers.iter().fold(0, |acc, m| acc | m.bit())
    }

    /// Modifier bits with one modifier excluded (used while pressing/releasing
    /// that very modifier — it shouldn't list itself as already-held).
    fn bits_excluding(&self, exclude: Modifier) -> i64 {
        self.modifiers
            .iter()
            .filter(|m| **m != exclude)
            .fold(0, |acc, m| acc | m.bit())
    }

    /// The printable `text` to attach to the main key's `keyDown`, if any. We
    /// only attach text for a single printable character pressed without Ctrl /
    /// Meta / Alt (those are shortcuts, not text entry). Shift uppercases.
    fn printable_text(&self) -> Option<String> {
        let suppress = self
            .modifiers
            .iter()
            .any(|m| matches!(m, Modifier::Ctrl | Modifier::Meta | Modifier::Alt));
        if suppress {
            return None;
        }
        let mut chars = self.raw_key.chars();
        let (c, rest) = (chars.next(), chars.next());
        if let (Some(c), None) = (c, rest) {
            if c.is_ascii_graphic() || c == ' ' {
                let has_shift = self.modifiers.contains(&Modifier::Shift);
                let out = if has_shift { c.to_ascii_uppercase() } else { c };
                return Some(out.to_string());
            }
        }
        None
    }
}

/// Parse a `"Mod+Mod+Key"` combo into a [`Combo`]. The last `+`-segment is the
/// main key; every earlier segment must be a known modifier. Returns `None` on
/// an empty combo, an unknown modifier, or an unsynthesizable main key.
fn parse_combo(combo: &str) -> Option<Combo> {
    let combo = combo.trim();
    if combo.is_empty() {
        return None;
    }
    // Split on '+', but treat a trailing literal '+' key (e.g. "Ctrl++") as the
    // main key being '+'.
    let parts: Vec<&str> = combo.split('+').collect();
    let (mods, key_tok) = if parts.len() >= 2 && parts.last() == Some(&"") {
        // "...+" → main key is '+'
        (&parts[..parts.len() - 2], "+")
    } else {
        (&parts[..parts.len() - 1], *parts.last()?)
    };

    let mut modifiers = Vec::new();
    for m in mods {
        modifiers.push(Modifier::parse(m.trim())?);
    }
    let key = key_def(key_tok.trim())?;
    Some(Combo {
        modifiers,
        key,
        raw_key: key_tok.trim().to_string(),
    })
}

/// Build the `wait_for` boolean JS expression for a predicate.
fn wait_expr(pred: &WaitFor) -> String {
    match pred {
        WaitFor::Url(s) => format!("location.href.includes({})", js_str(s)),
        WaitFor::Text(s) => format!(
            "(document.body ? document.body.innerText : '').includes({})",
            js_str(s)
        ),
        WaitFor::GoneText(s) => format!(
            "!(document.body ? document.body.innerText : '').includes({})",
            js_str(s)
        ),
        WaitFor::Selector(s) => format!("!!document.querySelector({})", js_str(s)),
        WaitFor::GoneSelector(s) => format!("!document.querySelector({})", js_str(s)),
        WaitFor::Idle => "document.readyState === 'complete'".to_string(),
    }
}

/// JSON-encode a string into a JS string literal (safe interpolation).
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

// Static per-letter / per-digit descriptor tables (so `KeyDef` fields stay
// `&'static str` without leaking). Index A..Z and 0..9.
const LETTER_DEFS: [KeyDef; 26] = [
    KeyDef { key: "a", code: "KeyA", vk: 65 },
    KeyDef { key: "b", code: "KeyB", vk: 66 },
    KeyDef { key: "c", code: "KeyC", vk: 67 },
    KeyDef { key: "d", code: "KeyD", vk: 68 },
    KeyDef { key: "e", code: "KeyE", vk: 69 },
    KeyDef { key: "f", code: "KeyF", vk: 70 },
    KeyDef { key: "g", code: "KeyG", vk: 71 },
    KeyDef { key: "h", code: "KeyH", vk: 72 },
    KeyDef { key: "i", code: "KeyI", vk: 73 },
    KeyDef { key: "j", code: "KeyJ", vk: 74 },
    KeyDef { key: "k", code: "KeyK", vk: 75 },
    KeyDef { key: "l", code: "KeyL", vk: 76 },
    KeyDef { key: "m", code: "KeyM", vk: 77 },
    KeyDef { key: "n", code: "KeyN", vk: 78 },
    KeyDef { key: "o", code: "KeyO", vk: 79 },
    KeyDef { key: "p", code: "KeyP", vk: 80 },
    KeyDef { key: "q", code: "KeyQ", vk: 81 },
    KeyDef { key: "r", code: "KeyR", vk: 82 },
    KeyDef { key: "s", code: "KeyS", vk: 83 },
    KeyDef { key: "t", code: "KeyT", vk: 84 },
    KeyDef { key: "u", code: "KeyU", vk: 85 },
    KeyDef { key: "v", code: "KeyV", vk: 86 },
    KeyDef { key: "w", code: "KeyW", vk: 87 },
    KeyDef { key: "x", code: "KeyX", vk: 88 },
    KeyDef { key: "y", code: "KeyY", vk: 89 },
    KeyDef { key: "z", code: "KeyZ", vk: 90 },
];

const DIGIT_DEFS: [KeyDef; 10] = [
    KeyDef { key: "0", code: "Digit0", vk: 48 },
    KeyDef { key: "1", code: "Digit1", vk: 49 },
    KeyDef { key: "2", code: "Digit2", vk: 50 },
    KeyDef { key: "3", code: "Digit3", vk: 51 },
    KeyDef { key: "4", code: "Digit4", vk: 52 },
    KeyDef { key: "5", code: "Digit5", vk: 53 },
    KeyDef { key: "6", code: "Digit6", vk: 54 },
    KeyDef { key: "7", code: "Digit7", vk: 55 },
    KeyDef { key: "8", code: "Digit8", vk: 56 },
    KeyDef { key: "9", code: "Digit9", vk: 57 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests — pure: geometry, key mapping, combo parsing, wait-expr. No Chrome/CDP.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── geometry ─────────────────────────────────────────────────────────────

    #[test]
    fn quad_center_averages_the_four_corners() {
        // A 10×20 box at origin: corners (0,0)(10,0)(10,20)(0,20) → centre (5,10).
        let q = vec![0.0, 0.0, 10.0, 0.0, 10.0, 20.0, 0.0, 20.0];
        assert_eq!(quad_center(&q), Some((5.0, 10.0)));
    }

    #[test]
    fn quad_center_rejects_short_quads() {
        assert_eq!(quad_center(&[1.0, 2.0]), None);
        assert_eq!(quad_center(&[]), None);
    }

    // ── modifier bits (CDP: Alt=1, Ctrl=2, Meta=4, Shift=8) ───────────────────

    #[test]
    fn modifier_bits_match_cdp_values() {
        assert_eq!(Modifier::Alt.bit(), 1);
        assert_eq!(Modifier::Ctrl.bit(), 2);
        assert_eq!(Modifier::Meta.bit(), 4);
        assert_eq!(Modifier::Shift.bit(), 8);
    }

    #[test]
    fn modifier_parse_handles_aliases() {
        assert_eq!(Modifier::parse("Ctrl"), Some(Modifier::Ctrl));
        assert_eq!(Modifier::parse("control"), Some(Modifier::Ctrl));
        assert_eq!(Modifier::parse("Cmd"), Some(Modifier::Meta));
        assert_eq!(Modifier::parse("command"), Some(Modifier::Meta));
        assert_eq!(Modifier::parse("Option"), Some(Modifier::Alt));
        assert_eq!(Modifier::parse("SHIFT"), Some(Modifier::Shift));
        assert_eq!(Modifier::parse("hyper"), None);
    }

    // ── key definitions ──────────────────────────────────────────────────────

    #[test]
    fn named_keys_map_to_expected_codes() {
        assert_eq!(key_def("Enter"), Some(KeyDef { key: "Enter", code: "Enter", vk: 13 }));
        assert_eq!(key_def("escape"), Some(KeyDef { key: "Escape", code: "Escape", vk: 27 }));
        assert_eq!(key_def("Tab"), Some(KeyDef { key: "Tab", code: "Tab", vk: 9 }));
        assert_eq!(key_def("Delete"), Some(KeyDef { key: "Delete", code: "Delete", vk: 46 }));
        assert_eq!(key_def("ArrowDown"), Some(KeyDef { key: "ArrowDown", code: "ArrowDown", vk: 40 }));
    }

    #[test]
    fn single_letters_and_digits_get_canonical_descriptors() {
        let a = key_def("a").unwrap();
        assert_eq!(a.code, "KeyA");
        assert_eq!(a.vk, 65);
        // uppercase letter maps to the same physical key
        let upper = key_def("A").unwrap();
        assert_eq!(upper.code, "KeyA");
        assert_eq!(upper.vk, 65);

        let five = key_def("5").unwrap();
        assert_eq!(five.code, "Digit5");
        assert_eq!(five.vk, 53);
    }

    #[test]
    fn unknown_multichar_key_is_rejected() {
        assert_eq!(key_def("NopeKey"), None);
        assert_eq!(key_def(""), None);
    }

    // ── combo parsing ────────────────────────────────────────────────────────

    #[test]
    fn parses_bare_key() {
        let c = parse_combo("Enter").unwrap();
        assert!(c.modifiers.is_empty());
        assert_eq!(c.key.code, "Enter");
        assert_eq!(c.modifier_bits(), 0);
    }

    #[test]
    fn parses_ctrl_s() {
        let c = parse_combo("Ctrl+S").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl]);
        assert_eq!(c.key.code, "KeyS");
        assert_eq!(c.modifier_bits(), 2);
        // Ctrl chord suppresses printable text (it's a shortcut, not entry).
        assert_eq!(c.printable_text(), None);
    }

    #[test]
    fn parses_multi_modifier() {
        let c = parse_combo("Ctrl+Shift+K").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl, Modifier::Shift]);
        assert_eq!(c.key.code, "KeyK");
        // Ctrl(2) | Shift(8) = 10
        assert_eq!(c.modifier_bits(), 10);
    }

    #[test]
    fn bits_excluding_drops_the_named_modifier() {
        let c = parse_combo("Ctrl+Shift+K").unwrap();
        // while pressing Ctrl itself, the held set is just Shift(8)
        assert_eq!(c.bits_excluding(Modifier::Ctrl), 8);
        assert_eq!(c.bits_excluding(Modifier::Shift), 2);
    }

    #[test]
    fn unknown_modifier_or_key_fails_parse() {
        assert!(parse_combo("Hyper+K").is_none());
        assert!(parse_combo("Ctrl+NopeKey").is_none());
        assert!(parse_combo("").is_none());
        assert!(parse_combo("   ").is_none());
    }

    #[test]
    fn trailing_plus_is_the_plus_key() {
        let c = parse_combo("Ctrl++").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl]);
        assert_eq!(c.raw_key, "+");
    }

    // ── printable text (text entry vs shortcut) ──────────────────────────────

    #[test]
    fn plain_letter_carries_lowercase_text() {
        let c = parse_combo("a").unwrap();
        assert_eq!(c.printable_text(), Some("a".to_string()));
    }

    #[test]
    fn shift_letter_carries_uppercase_text() {
        let c = parse_combo("Shift+a").unwrap();
        assert_eq!(c.printable_text(), Some("A".to_string()));
    }

    #[test]
    fn named_key_carries_no_printable_text() {
        let c = parse_combo("Enter").unwrap();
        assert_eq!(c.printable_text(), None);
    }

    // ── wait-for expressions ─────────────────────────────────────────────────

    #[test]
    fn wait_expr_builds_safe_predicates() {
        assert_eq!(
            wait_expr(&WaitFor::Url("/done".into())),
            "location.href.includes(\"/done\")"
        );
        assert_eq!(
            wait_expr(&WaitFor::Selector(".ready".into())),
            "!!document.querySelector(\".ready\")"
        );
        assert_eq!(
            wait_expr(&WaitFor::GoneSelector(".spinner".into())),
            "!document.querySelector(\".spinner\")"
        );
        assert_eq!(
            wait_expr(&WaitFor::Idle),
            "document.readyState === 'complete'"
        );
    }

    #[test]
    fn wait_expr_escapes_interpolated_values() {
        // A value with a quote must not break out of the JS string literal.
        let expr = wait_expr(&WaitFor::Text("say \"hi\"".into()));
        assert!(expr.contains("\\\"hi\\\""), "got: {expr}");
    }
}
