# iyke-mcp

MCP server that exposes the Ikenga desktop app's Iyke control bridge to Claude. Tools mirror the `iyke` CLI subcommands so a Claude session in any terminal can drive the app the same way a developer types into `iyke` at a shell.

## Install

```bash
cd iyke-mcp
bun install
```

Then register it with Claude Code at the user (global) scope so it's available from every project:

```bash
claude mcp add iyke -s user -- bun run /home/nedjamez/royalti-co/iyke-mcp/src/index.ts
```

After that, any Claude session can call `mcp__iyke__state`, `mcp__iyke__go`, `mcp__iyke__mode`, `mcp__iyke__open`, `mcp__iyke__split`, `mcp__iyke__focus`, `mcp__iyke__close`.

## Tools

| Tool          | Purpose                                                                 |
|---------------|-------------------------------------------------------------------------|
| `iyke_state`  | Show current sidebar mode + focused pane's route. Use before navigating |
| `iyke_go`     | Navigate the focused pane to a route path                               |
| `iyke_mode`   | Switch sidebar activity mode                                            |
| `iyke_open`   | Open a new tab in the focused pane (route/terminal/chat/artifact/mini-app) |
| `iyke_split`  | Split the focused or specified pane horizontally/vertically             |
| `iyke_focus`  | Focus a pane by id or 1-based DFS leaf index (⌃1..⌃6)                   |
| `iyke_close`  | Close a pane (focused if `pane_id` omitted)                             |

## Behavior when the app isn't running

Every tool fails with a structured error rather than hanging. Claude reads the failure and reports it instead of silently waiting. A stale `control.json` left behind by `kill -9` is auto-deleted once it's at least 5 minutes old; younger stale files are reported (likely a launch race) so we don't clobber a starting app.
