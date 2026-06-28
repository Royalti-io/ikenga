//! Multi-window substrate (plans/multi-window).
//!
//! WP-02 (this commit) lands the `G-WINDOW-MODEL` contract: the
//! [`WindowDescriptor`] (what a window is) + the cross-window event envelope
//! ([`WindowEventEnvelope`]). Both are the Rust source-of-truth mirrored by the
//! TS Zod schema in `@ikenga/contract` at `src/window.ts`.
//!
//! The window registry + spawn/close/list lifecycle that consumes this contract
//! lands in WP-03.

pub mod descriptor;
pub mod events;
pub mod registry;

#[allow(unused_imports)]
pub use descriptor::{WindowDescriptor, WindowKind};
// Some re-exports (WINDOW_CONTRACT_VERSION, WINDOW_TARGETED_CHANNELS) are
// consumed by WP-04's channel migration, not yet here.
#[allow(unused_imports)]
pub use events::{
    topics, WindowEventEnvelope, WindowEventTarget, WINDOW_CONTRACT_VERSION,
    WINDOW_TARGETED_CHANNELS,
};
#[allow(unused_imports)]
pub use registry::{emit_to_focused, emit_to_label, WindowRegistry};
