---
"ikenga-desktop": patch
---

Harden pane/pin screenshot capture so it can no longer freeze or crash the WebKitGTK renderer. Pane capture now prefers a native window-crop (capture the window via the OS tool, crop to the pane's rect with the `image` crate) and only falls back to the synchronous `modern-screenshot` DOM clone when the pane has its own off-screen content — and that fallback is gated by a node-count ceiling that declines cleanly instead of attempting a clone large enough to trip the JSC watchdog. Native-crop validates the captured PNG against the window's outer size before trusting the crop and caches an "unreliable" verdict per compositor (e.g. focus-dependent `gnome-screenshot -w`) so later captures skip the doomed probe. Also: Windows window-capture now falls back to the FE path instead of hard-erroring; the iyke screenshot CLI timeout is raised 15s→70s; and a dropped `log::warn!` in the global-shortcut registration is switched to `tracing::warn!`.
