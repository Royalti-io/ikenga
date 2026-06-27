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

// Re-exports consumed by WP-03 (the window registry). Not referenced yet in the
// WP-02 contract-only commit.
#[allow(unused_imports)]
pub use descriptor::{WindowDescriptor, WindowKind};
#[allow(unused_imports)]
pub use events::{
    topics, WindowEventEnvelope, WindowEventTarget, WINDOW_CONTRACT_VERSION,
    WINDOW_TARGETED_CHANNELS,
};
