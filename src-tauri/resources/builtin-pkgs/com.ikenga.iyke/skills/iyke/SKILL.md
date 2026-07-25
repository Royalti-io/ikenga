---
name: iyke
description: Drive the running Ikenga desktop app from a Claude Code session — read its DOM, query its TanStack cache, navigate panes, capture screenshots, click and type. ALSO the multi-agent orchestration surface — spawn and control terminals running any LLM CLI, coordinate through scratchpads, todos, locks and leases, and read or write the task board. Use when the user is running the desktop app (or asks you to verify something inside it), or when you are orchestrating several agents or terminals to carry out multi-phase work.
---

# Iyke — desktop control bridge

The `iyke` CLI talks to a localhost HTTP bridge that the **Ikenga desktop app** exposes when it's running. It lets you (Claude) drive the UI and inspect runtime state from a terminal — DOM trees, console logs, network captures, query-cache contents, screenshots, click + type + key.

When this skill is loaded, the `iyke` binary is on `$PATH` (installed by the desktop app via the kernel's claude-assets registry). The app must be running for any command to work — if it isn't, every command exits with a "could not reach iyke server" error and you should ask the user to launch the app.

## When to use this skill

Trigger when ANY of:
- The user is iterating on a feature inside the PA desktop app and asks you to "check what it shows" / "click that button" / "see the DOM" / "grab a screenshot."
- The user asks you to verify a smoke test or end-to-end behaviour in the running app.
- You're installing a package via the kernel and need to confirm its registries fired (use `iyke logs`, then grep for the smoke output).
- The user says "drive the app", "use iyke", or names any iyke subcommand directly.

Do NOT trigger for:
- Code changes (use Read/Edit/Write).
- Talking to the user about UI state in the abstract — only when you actually need to query or change the running app.

## Core commands (memorise these)

```
iyke state                    # what's the app doing right now? mode, focused route, panes
iyke go <path>                # set the focused pane's route, e.g. iyke go /finance
iyke open route <path>        # open a NEW tab in the focused pane (preserves history)
iyke mode <mode>              # switch sidebar activity mode (files, mail, agents, ...)
iyke dom                      # accessibility-tree snapshot of the focused pane (refs e1, e2 stable until next snapshot)
iyke logs                     # recent console logs from the webview (use this to read smoke-test output)
iyke network                  # last 100 fetch+XHR requests
iyke query-cache              # TanStack Query cache contents
iyke screenshot               # capture focused pane → ~/.local/share/ikenga/screenshots/
iyke click --ref e7           # click by ref from `iyke dom`
iyke click --text "Save"      # click by visible text
iyke type --ref e3 "hello"    # type into an input
iyke key Enter                # dispatch a key combo: Enter, Ctrl+S, Meta+K
iyke wait <predicate>         # block until predicate matches; non-zero on timeout
iyke refresh                  # re-mount the focused pane (React key bump)
iyke focus <id|index>         # focus a pane by id or 1-based DFS index (matches Ctrl+1..Ctrl+6)
iyke split                    # split the focused pane
iyke close                    # close focused (or specified) pane
iyke iframe-state             # read the latest published state from an iframe pane (e.g. the tasks pkg's open-task selection)
iyke iframe-send <pane> <evt> # postMessage into an iframe pane
iyke devtools                 # open DevTools (debug builds only)
```

Add `--json` to most commands for structured output.

## Important quirks (these tripped earlier work)

1. **`iyke logs` has no `--since` flag** — the option is broken in the current build. Read all recent logs and grep client-side: `iyke logs | grep my-smoke-tag`.
2. **DOM refs are NOT stable across navigations** — if you `iyke go` or `iyke refresh`, re-run `iyke dom` before clicking. A stale ref clicks the wrong element.
3. **The focused pane is what `iyke go` and `iyke dom` operate on.** If the user has multiple panes open, run `iyke state` first to see which is focused. Switch with `iyke focus <index>` (1-based, matching the Ctrl+N keybindings).
4. **React strict-mode mounts effects 2× in dev** — when asserting on counters from `iyke logs`, use `> 0`, not `=== 1`.
5. **`iyke open route`** opens a NEW tab; `iyke go` reuses the focused tab. Prefer `iyke go` unless you specifically want to preserve the existing pane.

## Reading pkg panes (Tasks, Agent Ops, …)

Pkg mini-apps mount as **same-origin srcdoc iframes**, and `iyke dom` descends into them — the pane's content appears inline in the snapshot (under an `iframe "com.ikenga.tasks"` node). `iyke click --text` / `--selector`, `iyke type`, and `iyke wait` also resolve targets inside pkg panes. **Do NOT open SQLite to answer "what is the pane showing"** — the DB can't tell you what's selected on screen anyway. Fast paths, in order:

```bash
iyke state --json             # leaves[] carry `pkg` + `state` for pkg panes — e.g.
                              #   {"pkg":"com.ikenga.tasks","state":{"selection":{"view":"tasks","taskId":"…"}}}
iyke iframe-state --pane com.ikenga.tasks   # same `state` object, fetched live (pane-leaf ids work too)
iyke dom                      # full a11y tree incl. pkg-pane content; add --pane com.ikenga.tasks to scope
```

With the selected entity's id from `state.selection`, a *data* follow-up (not a UI question) can then go to SQLite — see *When iyke isn't enough* for the path.

## Common patterns

### Verify a smoke test
```bash
iyke go /my-smoke-route
sleep 3
iyke logs | grep my-smoke
```
The smoke route's React component logs results to `console.log("[my-smoke] ...")`; grep for them in the webview log buffer.

### Click an element by visible text
```bash
iyke dom > /tmp/dom.txt        # optional: cache the snapshot
iyke click --text "Save changes"
```
If the text isn't unique, fall back to `--ref` after inspecting the snapshot.

### Wait for an async operation to land
```bash
iyke click --text "Send"
iyke wait --selector '[data-testid="sent-confirmation"]' --timeout 10000
```
`wait` exits non-zero on timeout, so you can chain it in a script.

### Read TanStack query cache
```bash
iyke query-cache --json | jq '.queries[] | select(.queryKey[0] == "tasks")'
```
Useful when you want to see the data the UI is rendering without scraping the DOM.

## Multi-agent orchestration

Everything above drives the UI. This section is the other half: the control
plane for running **several terminals — each with a different LLM CLI — through
a multi-phase job**. All of it is HTTP on the same bridge (`$IYKE_URL` +
bearer token from `control.json`); the CLI covers some of it, `curl` covers the
rest.

### Terminals are the substrate

A terminal is anything with a CLI: `claude`, `gemini`, `codex`, `cursor-agent`,
`aider`, a test runner, a REPL. Two ids matter and they are not the same thing:

- `terminal_id` — stable, survives the process. **Address everything by this.**
- `pty_id` — the running process. Changes when a shell exits and restarts.

```
POST /iyke/terminal/spawn   {cwd, argv, title, label, pane, lease_for, lease_ttl_ms}
POST /iyke/terminal/kill    {terminal, close_tab}
POST /iyke/terminal/label   {terminal, label}      # unique name among live terminals
POST /iyke/terminal/lease/acquire {terminal, agent_id, ttl_ms}   → {token, expires_at}
POST /iyke/terminal/send    {terminal, data, keys, lease_token, expected_pty_id}
POST /iyke/terminal/wait    {terminal, match|until_idle_ms, after, timeout_ms}
GET  /iyke/terminal/read?terminal=&after=          # cursor read
GET  /iyke/terminal/list                           # every live terminal + foreground cmd
```

Three safety rails, all worth using:

- **Leases.** `lease_for` on spawn (or `lease/acquire` later) gives you a token.
  Once a terminal is leased, a `send` **without** the matching token is rejected.
  This is what stops two agents typing into the same shell.
- **`expected_pty_id`.** Pin the send to the process you think you're talking to.
  If the shell died and respawned, the write is refused instead of landing in a
  fresh shell that has no idea what you were doing.
- **Cursor reads.** `after` = the last `end_offset` you saw. The response carries
  `truncated` when the ring (256 KB) overflowed past your cursor — if you see it,
  you lost output and should be checkpointing to a scratchpad more often.

`wait` is the only blocking primitive. Prefer `match` on a sentinel you told the
model to print (`<<<DONE:impl-a>>>`) over `until_idle_ms`, which cannot tell
"finished" from "thinking".

Labels and leases are **runtime-only** — an app restart drops them. Durable
orchestration state belongs in scratchpads, todos and KV.

### Scratchpads — the shared blackboard

```
POST /iyke/scratchpad/write   {scope, name, body}
POST /iyke/scratchpad/append  {scope, name, body}
GET  /iyke/scratchpad/read?scope=&name=
GET  /iyke/scratchpad/watch?scope=&name=&since=&wait_ms=     # long poll
```

`watch` is the **only push-shaped primitive in the whole bridge**. It blocks
until `updated_at > since`, then returns the new body (or `deleted: true`).
Everything else is request/response.

Three rules that will save you:

1. **One writer per pad.** `(scope, name)` is unique and writes are
   last-writer-wins with no merge and no conflict signal. Partition by name —
   `phase2/spec` owned by the orchestrator, `phase2/worker-a` owned by worker A.
2. **Scope defaults to `project:<active project id>`.** Pass `scope` explicitly
   for anything cross-project, or your pads silently follow whatever project the
   human last clicked.
3. **Use `append` for logs**, `write` for documents. `write` replaces.

The human sees the same pads in the sidebar and can edit them mid-run. That is
the feature: a plan in a scratchpad is a document you and they share, not a
buried chat message.

### Todos — the execution graph

```
POST /iyke/todo/create   {scope, title, body, tags, assignee, blocker_id, task_id}
POST /iyke/todo/update   {id, status, assignee, blocker_id, ...}
POST /iyke/todo/complete {id}
GET  /iyke/todo/list?scope=&status=&assignee=&tag=
```

`blocker_id` is a self-reference: **this is a dependency DAG**, which is how you
encode phase ordering. `assignee` should be the terminal label that owns the
node. `task_id` links a runtime todo to the durable task it serves.

### Locks, KV, timers, inbox

```
POST /iyke/lock/acquire  {scope, resource, holder, ttl_ms}   # before shared writes
POST /iyke/lock/release  {scope, resource, holder}
POST /iyke/kv/set        {scope, key, value}
POST /iyke/timer/schedule {scope, fire_at, agent_id, payload}
GET  /iyke/agent/inbox?agent_id=&since=      # timer fires land here
POST /iyke/agent/inbox/ack {ids}             # ack deletes
```

Take a lock before two workers touch the same files. Locks expire (a sweeper
reaps them), so a crashed agent doesn't wedge the run forever.

### Tasks — the durable board

```
GET  /iyke/task/list?status=&assigned_to=&project_path=
POST /iyke/task/create   {title, description, priority, assigned_to, actor}
POST /iyke/task/update   {id, status, progress_pct, task_result, actor}
POST /iyke/task/complete {id, task_result, outcome_notes, actor}
```

Agents have full write access here. **Always pass `actor`** — every mutation
appends a `task_events` row naming you, and that audit trail is the only reason
unrestricted write access is safe. Tasks are what the human works from; todos
are your scratch execution graph. Don't confuse them.

### The orchestration shape

```
register agent
  ↓
spawn N terminals (label + lease each at spawn)
  ↓
write the phase spec to a scratchpad
  ↓
send each worker its prompt (expected_pty_id set)
  ↓
wait on each worker's sentinel  ──→  workers checkpoint into their own pads
  ↓
take a lock before touching shared files
  ↓
complete todos → unblocks the next phase via blocker_id
  ↓
write the outcome back to the task (actor = you)
```

Failure discipline: if a `wait` times out, **read** before you retry — the model
may be waiting on a prompt rather than stuck. Never send into a terminal you
don't hold the lease for. Two failed attempts on the same terminal, then stop
and surface it.

## When iyke isn't enough

Iyke can read and drive the running app, but it can NOT:
- Run Tauri commands directly (use the `pkg_*` / `iyke_*` HTTP routes that ARE exposed; otherwise spawn a child process and call them another way)
- Modify Rust code (use Edit/Write)
- Inspect SQLite directly. The app's local store is `ikenga.db` in the app data dir — Linux `~/.local/share/app.ikenga/ikenga.db`, macOS `~/Library/Application Support/app.ikenga/ikenga.db`. Open it read-only (`sqlite3 'file:…/ikenga.db?mode=ro'`). Ignore any stale `pa.db` sitting next to it — that's the pre-rename legacy file and is NOT what the running app writes.

If you're hitting a limit, surface it and ask — don't loop on the same failing iyke command. Two attempts max.
