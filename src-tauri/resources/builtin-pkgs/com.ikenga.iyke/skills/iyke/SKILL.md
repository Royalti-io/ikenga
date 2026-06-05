---
name: iyke
description: Drive the running Ikenga desktop app from a Claude Code session — read its DOM, query its TanStack cache, navigate panes, capture screenshots, click and type. Use when the user is running the desktop app (or asks you to verify something inside it) and you need to inspect or change its state without them taking their hands off the keyboard.
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

## When iyke isn't enough

Iyke can read and drive the running app, but it can NOT:
- Run Tauri commands directly (use the `pkg_*` / `iyke_*` HTTP routes that ARE exposed; otherwise spawn a child process and call them another way)
- Modify Rust code (use Edit/Write)
- Inspect SQLite directly. The app's local store is `ikenga.db` in the app data dir — Linux `~/.local/share/app.ikenga/ikenga.db`, macOS `~/Library/Application Support/app.ikenga/ikenga.db`. Open it read-only (`sqlite3 'file:…/ikenga.db?mode=ro'`). Ignore any stale `pa.db` sitting next to it — that's the pre-rename legacy file and is NOT what the running app writes.

If you're hitting a limit, surface it and ask — don't loop on the same failing iyke command. Two attempts max.
