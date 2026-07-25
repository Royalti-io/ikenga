---
'ikenga-desktop': patch
---

Agents driving Ikenga over the iyke bridge can now create the terminals they
work in, read what their timers fired, and link that runtime work to the durable
task board — the three gaps that made the multi-agent story unreachable from
outside the app.

- **Terminal lifecycle** — `POST /iyke/terminal/{spawn,kill}`. Spawn round-trips
  through the frontend so an agent's terminal is an ordinary visible tab you can
  watch, pop out, or take over, rather than an invisible Rust-local PTY. The
  follow-up lease addresses a concrete `pty_id`, since one terminal can own
  several PTY records and taking the first match could lease a dead one.
- **Agent inbox** — `GET /iyke/agent/inbox` + `POST /iyke/agent/inbox/ack`.
  Timers had been writing to `iyke_agent_inbox` all along with no way to read it,
  which made `/iyke/timer/schedule` a no-op for agents. Scheduling against an
  unregistered agent now returns an actionable 400 instead of a raw foreign-key
  error.
- **Task board link** — migration 0057 adds a nullable `iyke_todos.task_id`
  (deliberately no foreign key, so deleting a task orphans a runtime todo rather
  than failing), plus `/iyke/task/{list,create,update,complete}`.
- **Email actions** — migration 0056 adds `email_actions` +
  `email_triage_cursor`, with proposal lifecycle columns keeping proposals,
  approvals, and executions in one audit trail.

Supporting UX: terminal tabs are named for what they run and where
(`claude · shell`) instead of every tab reading "Terminal"; dropped OS files
route to the surface under the cursor, inserting a shell-quoted path in a
terminal or attaching an image in the composer; the updater holds at `installed`
and never auto-relaunches, so a restart can't discard in-flight work; detached
windows can set their own OS title so pop-outs are distinguishable in the window
list.
