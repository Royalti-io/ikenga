---
'ikenga-desktop': patch
---

Reopening Ikenga while it's already running now focuses the existing window
instead of launching a second copy. Previously a double-clicked launcher (or an
app reopen during an update) forked a whole second instance — its own SQLite
handle, iyke bridge, and pkg kernel — which then raced the running instance on
the shared database. Added `tauri-plugin-single-instance`, registered first so
the second process forwards its launch to the running window and exits.
