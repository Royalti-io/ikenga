//! Composable-app package kernel.
//!
//! See `kernel.rs` for the lifecycle entry points and `manifest.rs` for the
//! on-disk contract. Concrete registries live in `registries/`.
//!
//! Wiring: built in `lib.rs::run()::setup`, stored in app state, exposed via
//! the `pkg_*` Tauri commands in `commands::pkg`.

pub mod cap_snapshot;
// WP-02 foundation: detection + launcher are standalone until the kernel/command
// wiring lands in later WPs (WP-04 lifecycle, WP-07 routing). Allow dead-code so
// the unconsumed public API doesn't warn in the interim.
#[allow(dead_code)]
pub mod engine_adapter;
pub mod engine_adapters;
pub mod file_watcher;
pub mod http_proxy;
pub mod keep_awake;
pub mod kernel;
pub mod lifecycle;
pub mod manifest;
pub mod mcp_runtime;
pub mod permissions_check;
pub mod registries;
pub mod registry;
pub mod signature;
pub mod skill_actions;
pub mod source;
pub mod trust;
pub mod webview;

pub use engine_adapter::EngineAdaptersRegistry;
pub use kernel::{
    DiscoveredPkg, InstalledSummary, Kernel, KernelStatus, PkgHealthIssue,
};
pub use lifecycle::SidecarSupervisor;
pub use registry::Registry;
pub use source::InstallSource;
