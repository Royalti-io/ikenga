//! Cross-platform keep-awake assertions for browser-pkg webviews.
//!
//! Two mitigations, applied on a per-call basis around browser MCP tool
//! dispatch (defensive Yellow strategy from Phase 0.5 — see `CLAUDE.md`):
//!
//! 1. **macOS**: hold an `NSProcessInfo.beginActivityWithOptions(.userInitiated)`
//!    while any browser tool call is in flight. Prevents App Nap from
//!    throttling the host process when its window is occluded / minimized.
//! 2. **Windows**: assert `CoreWebView2Controller.IsVisible = true` on the
//!    browser-owned webview so WebView2 doesn't suspend the renderer when the
//!    host Tauri window is minimized.
//!
//! Linux is a no-op — Phase 0.5 confirmed WebKitGTK ignores focus throttling
//! for host-driven eval (sub-3ms p95 in every state on Wayland).
//!
//! ## RAII model
//!
//! `InflightGuard::acquire()` returns a guard that holds the platform-specific
//! assertions for its lifetime. Drop = release. Inside one process the macOS
//! activity is reference-counted via a `Weak` singleton so multiple concurrent
//! tool calls share one `beginActivity` token (cheaper, and the docs are clear
//! that nested activities are allowed but redundant).
//!
//! ## Where this is called from
//!
//! Every command in `commands/pkg_webview.rs` takes a guard at the top of its
//! handler. The webview eval, navigate, and rect-set paths each get their own
//! short-lived guard. For long-lived tool runs (e.g. the future `pkg-browser`
//! MCP `wait_for` command) the guard sits in the supervisor and is released
//! when the tool call returns.

use std::sync::{Arc, Mutex, OnceLock, Weak};

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2_foundation::{NSActivityOptions, NSObject, NSProcessInfo, NSString};

    /// Single retained `NSObject` token returned by `beginActivityWithOptions`.
    /// Drop calls `endActivity` against the same `NSProcessInfo`.
    ///
    /// `beginActivityWithOptions_reason` returns `Retained<ProtocolObject<dyn
    /// NSObjectProtocol>>` per the objc2-foundation 0.2 binding, but
    /// `endActivity` strictly wants `&NSObject`. We cast the returned handle
    /// to `Retained<NSObject>` at construction so the drop site can pass
    /// `&self.0` directly. The cast is sound because every Objective-C
    /// object IS an NSObject at the runtime level — the protocol-object
    /// wrapper is purely a type-system convenience.
    pub(super) struct ActivityToken(Retained<NSObject>);

    impl ActivityToken {
        pub(super) fn begin(reason: &str) -> Self {
            // `.UserInitiated` is the Apple-documented answer for "we're doing
            // work; don't nap us." It bundles SuddenTerminationDisabled and
            // AutomaticTerminationDisabled too — both desired while a browser
            // automation flow is mid-step.
            //
            // Intentionally NOT adding `.IdleSystemSleepDisabled` — that
            // prevents the whole machine from sleeping, which is user-hostile.
            // App Nap inhibition is the precise tool for our case; system
            // sleep stays under the user's control.
            let opts = NSActivityOptions::UserInitiated;
            let pi = NSProcessInfo::processInfo();
            let ns_reason = NSString::from_str(reason);
            let proto_token = pi.beginActivityWithOptions_reason(opts, &ns_reason);
            // SAFETY: the runtime object behind a `ProtocolObject<dyn
            // NSObjectProtocol>` always inherits from NSObject; the cast is
            // a zero-cost retype.
            let token: Retained<NSObject> = unsafe { Retained::cast(proto_token) };
            log::debug!("[keep_awake.macos] beginActivity .UserInitiated reason={reason:?}");
            ActivityToken(token)
        }
    }

    impl Drop for ActivityToken {
        fn drop(&mut self) {
            // SAFETY: endActivity takes the same token beginActivity returned;
            // we retained it via the typed binding so the pointer is valid.
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
            log::debug!("[keep_awake.macos] endActivity");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    pub(super) struct ActivityToken;
    impl ActivityToken {
        pub(super) fn begin(_reason: &str) -> Self {
            ActivityToken
        }
    }
}

/// Process-wide singleton: at most one `NSProcessInfo` activity at a time.
/// Multiple concurrent `InflightGuard`s share it via `Arc<ActivityToken>`.
static ACTIVITY: OnceLock<Mutex<Weak<macos::ActivityToken>>> = OnceLock::new();

/// Hand-out from `acquire`. Holding it = at least one tool call is in flight.
/// Dropping the last one releases the macOS activity (and is a no-op on
/// Linux/Windows).
pub struct InflightGuard {
    _activity: Option<Arc<macos::ActivityToken>>,
}

/// Acquire a keep-awake guard. Idempotent under concurrency: nested calls
/// share a single `beginActivity` token, released on the last drop.
pub fn acquire(reason: &'static str) -> InflightGuard {
    let slot = ACTIVITY.get_or_init(|| Mutex::new(Weak::new()));
    let mut g = slot.lock().expect("keep_awake activity lock poisoned");
    let token = match g.upgrade() {
        Some(existing) => existing,
        None => {
            let fresh = Arc::new(macos::ActivityToken::begin(reason));
            *g = Arc::downgrade(&fresh);
            fresh
        }
    };
    InflightGuard {
        _activity: Some(token),
    }
}

// ── Windows: WebView2 IsVisible hold ─────────────────────────────────────────
//
// Called per-eval at the boundary, plus once at window-creation time wired to
// `on_window_event` so minimize transitions don't silently flip IsVisible.

#[cfg(windows)]
pub fn pin_visible(webview: &tauri::Webview) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    webview.with_webview(|wv| unsafe {
        let ctrl: ICoreWebView2Controller = wv.controller();
        // SetIsVisible(true) re-asserts visibility even when the host HWND is
        // occluded/minimized. WebView2 toggles this internally; we toggle it
        // back. Cheap (no rasterization until painted) and load-bearing for
        // background eval RTT.
        let _ = ctrl.SetIsVisible(true);
        // We deliberately do NOT call TrySuspend / Resume here. TrySuspend is
        // an opt-in; if we never call it, the renderer never suspends, which
        // is exactly what browser-pkg webviews want.
    })?;
    Ok(())
}

#[cfg(not(windows))]
pub fn pin_visible(_webview: &tauri::Webview) -> tauri::Result<()> {
    Ok(())
}
