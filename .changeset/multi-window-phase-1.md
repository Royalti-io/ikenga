---
"ikenga-desktop": minor
---

Multi-window Phase 1 — thin-window substrate + Flavor C (detach single surfaces).

A window is now a thin webview rendering a declared `surface_set`, backed by the
shared Rust core and coordinated by Tauri events (no client-cache mirroring).
Adds the `G-WINDOW-MODEL` contract (`@ikenga/contract/window`), a Rust window
registry (`window_spawn`/`close`/`list`), per-window-aware pkg-pane parenting
(de-`"main"`'d), a thin `boot/detached` FE entry with per-window state isolation,
and **pop-out** detached windows for **chat**, **viewer**, and **terminal**
surfaces (the terminal attaches to the shared core PTY without owning it). The
primary window is unchanged. Per-window cost on Linux: a thin detached window is
~half a full window's WebKitWebProcess RSS.
