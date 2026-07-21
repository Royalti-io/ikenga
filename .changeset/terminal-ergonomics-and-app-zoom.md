---
'ikenga-desktop': minor
---

Terminal ergonomics, app-wide zoom, and a collapsible sidebar.

- **Shift+Enter inserts a soft newline** in the terminal instead of submitting.
  A bare terminal can't distinguish Shift+Enter and sends a carriage return for
  both, so multi-line input in the `claude` CLI (and other TUIs that accept it)
  didn't work; Shift+Enter now sends a line feed the app reads as a literal
  newline — the same distinction `/terminal-setup` configures in iTerm2 / VS Code.
- **App-wide zoom** (⌘/⌃ with `=` / `-` / `0`). One level for the whole shell —
  chrome, panes, pkg iframes, and the xterm canvas — applied at the webview
  level so text stays hinted and the terminal re-fits its PTY correctly. A
  discrete ladder means zoom-out then zoom-in always returns to a crisp 1.0.
  The level persists and syncs across detached pop-out windows.
- **Collapsible sidebar.** ⌘B toggles it, and clicking the already-active
  activity-bar item collapses/reopens it (clicking a different item always
  reopens). The collapsed state persists across restarts.
- **`/iyke/sidebar` verb** (`toggle` | `open` | `close`) drives the same state
  over the iyke bridge, and the sidebar's collapsed state is now reported in
  `/iyke/state` so it's observable, not just actuate-only.
