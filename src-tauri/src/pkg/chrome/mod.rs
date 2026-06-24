//! Managed-mode Chrome engine for `pkg-browser` (WP-02 onward).
//!
//! "Managed mode" = the shell launches the user's *installed* Google Chrome
//! with a dedicated `--user-data-dir` + `--remote-debugging-port` and drives it
//! over the Chrome DevTools Protocol (CDP) via `chromiumoxide`. It is the
//! `engine = "chrome"` counterpart to the in-shell WebKit child-webview engine
//! in [`crate::pkg::webview`]. See `plans/chrome-pkg/` for the full design;
//! `06-cdp-engine-decisions.md` (DEC-A/DEC-B) for why chromiumoxide + a
//! shell-owned process.
//!
//! WP-02 lands the foundation: cross-OS Chrome **detection** ([`detect`]) and a
//! **launcher** ([`launcher`]) that spawns + CDP-attaches. Later WPs add the
//! profile store (WP-03), lifecycle/supervisor (WP-04), snapshot/ref adapter
//! (WP-05), and action verbs (WP-06) as sibling modules here. This module is
//! standalone — it is not yet wired into the kernel, registries, or commands.

pub mod detect;
pub mod launcher;
pub mod profile;

// Re-exports form the module's public API for later WPs (lifecycle, snapshot,
// actions, routing). Unused until those land — allow so the foundation lands
// warning-free.
#[allow(unused_imports)]
pub use detect::{detect_chrome, ChromeInstall, DetectError};
#[allow(unused_imports)]
pub use launcher::{launch_managed, LaunchOptions, ManagedChrome};
#[allow(unused_imports)]
pub use profile::managed_profile_dir;
