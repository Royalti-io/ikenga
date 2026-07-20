---
'ikenga-desktop': minor
---

Retire the per-session `CLAUDE_CONFIG_DIR` overlay; chat sessions now use claude's own discovery.

**Chat / transcripts**

- Chat sessions reach exact parity with a plain terminal: 143 skills, 33 agents, 298 commands, 23 MCP servers (was 129 / 33 / 271 / 8 under the overlay).
- Transcripts land in `~/.claude/projects` and are resumable with `claude --resume`, both inside and outside the app. 19 pre-existing transcripts were migrated.
- Transcript retention pinned rather than left unset, so the 30-day sweep no longer eats history.
- Abandoned threads are GC'd on close, safely under concurrent mounts.
- Claude child processes shut down gracefully on SIGTERM.

**Terminal**

- Pop-out no longer shows blank scrollback: buffered output is held until a live chunk actually lands, and the PTY attach seam is closed in Rust rather than deduped in JS.
- PTY reader-thread panic guard plus a live-session cap.
- Terminal PTY is disposed and the xterm/webgl context evicted on tab close.
- A SIGWINCH repaint nudge is issued when a terminal is attached into a
  detached pop-out, and again when the pane is reclaimed by the origin window,
  so a full-screen TUI is prompted to redraw at the geometry it is actually
  being displayed at. This does not repair scrollback that was already written
  at the previous geometry — raw-replay rewrap remains structural, and
  line-mode shells are unaffected by the nudge.

**Pkgs / kernel**

- Settings-secret env is injected into sidecars from Stronghold at both spawn sites.
- Pane lifecycle: xterm cache, stable tab keys, pooled pkg iframes, pkg-MCP event relay.
- Two-line pkg menu header with subtitles on `PkgMenuItem`.
- Studio: nested-route subresource inlining, `host.openFolder` trust wiring, dev-reload sidecar reap, per-folder trust gate.

**Fixes**

- `~/`-rooted paths are now detected by the terminal path linkifier, unblocking `resolvePath`'s previously unreachable tilde-expansion branch.
- Artifact `file:` data sources resolve against the artifact mount instead of falling through to mock.
- Dock ⌘J can no longer strand the dock in `hidden`.
- `main.tsx` can no longer brick on a failed boot module load.
- Revived the two dead `/iyke/logs` filters.
