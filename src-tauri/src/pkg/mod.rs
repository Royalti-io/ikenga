//! Composable-app package kernel.
//!
//! See `kernel.rs` for the lifecycle entry points and `manifest.rs` for the
//! on-disk contract. Concrete registries live in `registries/`.
//!
//! Wiring: built in `lib.rs::run()::setup`, stored in app state, exposed via
//! the `pkg_*` Tauri commands in `commands::pkg`.

pub mod cap_snapshot;
pub mod file_watcher;
pub mod keep_awake;
pub mod kernel;
pub mod lifecycle;
pub mod manifest;
pub mod mcp_runtime;
pub mod permissions_check;
pub mod registries;
pub mod registry;
pub mod source;
pub mod trust;
pub mod webview;

pub use kernel::{DiscoveredPkg, InstalledSummary, Kernel, KernelStatus};
pub use lifecycle::SidecarSupervisor;
pub use registry::Registry;
pub use source::InstallSource;
