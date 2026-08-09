---
'ikenga-desktop': minor
---

The in-app chat surface is gone, replaced by Chi — a runtime for driving coding
agents through the shell instead of a chat pane bolted onto it. **This is
user-visible and breaking**: anyone relying on the old in-shell chat pane will
find it removed, not migrated. The chat panel, its backend session store, and
`chat_sessions`/`chat_user_turns` are deleted outright (migration 0060), along
with the standalone AI-elements component library and the unused Gemini ACP
engine path it depended on. If you had conversations parked in the old chat
pane, they do not carry forward.

In its place:

- **Chi agent runtime.** New `chi_run` / `chi_resume` / `chi_cache` plumbing
  (migration 0059) drives real coding-agent sessions from the shell, with a
  local cache so history survives restarts. The Claude Code engine merges its
  native `~/.claude/projects` sessions into `chi_list`, so sessions started
  outside Ikenga show up alongside ones started inside it.
- **Multi-engine support.** Beyond Claude Code, `chi_run` now has real parity
  for a Codex engine, a stub for `cursor-agent`, and a new Antigravity engine —
  the legacy Gemini ACP path is retired in the same pass.
- **Terminal multiplexer + tmux persistence.** Chi runs live in a real
  multiplexed terminal backed by tmux sessions, so a run's terminal state
  survives disconnects instead of dying with the pane.
- **iyke HTTP bridge for Chi.** `/iyke/chi/{run,resume,status,list,cancel}`
  lets an external controller drive Chi the same way it already drives
  terminals and panes.
- **Headers-only mailbox index** (migration 0058, `email_index`) for faster
  mail lookups without pulling full message bodies.
- **Telemetry consent surface removed** along with the chat UI it was attached
  to.

Fixed:

- The sidebar's active section now re-syncs to whatever pkg route the focused
  pane is actually on, on both navigation and cold start — deep links and
  restored sessions no longer snap back to the generic "app" mode and lose
  their pkg-specific side menu.
- The artifact viewer now sends `Cache-Control: no-cache`, so editing an
  artifact file no longer leaves the viewer showing a stale cached copy.
