# Phase 0 Report — Tauri + xterm + PTY Spike

**Date:** 2026-04-30
**Branch:** `claude/pa-desktop-phase-0-qSDip` (development)
**Target:** PR to `main`

---

## Verdict: **GREEN — all 10 acceptance tests passed on 2026-04-30**

Operator (Chinedum) ran `bunx tauri dev` from `ikenga-desktop/` on
ThinkPad T490s (Pop_OS!/Ubuntu, Wayland + X11, libwebkit2gtk-4.1) and walked
through every test. All passed, including the critical Test 6 — `claude` TUI
renders cleanly inside xterm.js. Phase 0 gate is cleared; phase 1 may proceed.

Stream-json schema for phase 5 captured against real Claude Code v2.1.123 — see
§ Test 7-8 below; phase 3 doc's parser must be rewritten per the dispatch
sketch documented there.

(Test 3 substitution: `htop` not installed on dev box; used `top`/`less`
instead — same alt-screen-buffer purpose.)

---

## Environment used to author this spike

| Item | Value |
|---|---|
| Host OS | Ubuntu 24.04.4 LTS (sandbox VM) |
| Display | Headless. Xvfb was used for one smoke launch only. |
| Rust | 1.94.1 (matches `rust-version = "1.77"` floor) |
| Bun | 1.3.11 |
| Node | 22 |
| Tauri | 2 (CLI v2.10.1, framework v2.10.3) |
| WebKit2GTK | 2.50.4 (via `libwebkit2gtk-4.1-dev`) |
| `claude` on PATH | yes (`/opt/node22/bin/claude`) — but not exercised here |

---

## What was verified automatically

| # | Check | Result |
|---|---|---|
| A | `bun install` resolves all deps | ✅ 77 packages, no peer warnings |
| B | `bun run build` (tsc + vite) | ✅ 50 modules, 607 KB JS / 5.4 KB CSS |
| C | `cargo check --release` (Rust + Tauri toolchain) | ✅ clean |
| D | `cargo build` (debug, full link to webkit2gtk-4.1) | ✅ binary produced |
| E | `cargo clippy --release -- -D warnings` | ✅ no warnings |
| F | Tauri launches under Xvfb without panic (30s smoke) | ✅ Vite + Tauri stayed up; only `libEGL warning: DRI3 error` (expected for headless software GL) |

These gates rule out the most common phase-0 failure modes:

- Wrong tauri.conf.json schema → `cargo check` would fail at `tauri::generate_context!`
- Capability JSON malformed → would fail at codegen
- Missing icons → bundle codegen would fail
- IPC handler signature mismatch → `tauri::generate_handler!` macro would fail
- Tokio + portable-pty + dashmap version conflicts → would fail at `cargo build`

---

## 10 Manual Acceptance Tests

> Operator: run these locally with `bun install && bunx tauri dev` from
> `ikenga-desktop/`. Update each row's `Result` column and re-commit.

| # | Test | Pass criteria | Result | Notes |
|---|---|---|---|---|
| 1 | App launches, xterm renders | No console errors, cursor blinks | ✅ pass | — |
| 2 | Type `ls` + Enter in Bash pane | Output renders correctly, no garbled bytes | ✅ pass | — |
| 3 | Run `htop`, exit cleanly | Full-screen redraw, exit returns to shell | ✅ pass | `htop` not installed on dev box; used `top` / `less` instead — same alt-screen behavior verified |
| 4 | Run `vim file.txt`, edit, save, exit | Modes work, save persists | ✅ pass | — |
| 5 | Resize the window | Terminal reflows, no garbage | ✅ pass | — |
| 6 | Run `claude` in `~/royalti-co/` | **Claude TUI renders without artifacts** | ✅ pass | **Critical gate cleared.** TUI clean, truecolor, cursor positioning correct |
| 7 | In claude, ask "list files in current dir" | Tool runs, output formatted | ✅ pass | — |
| 8 | In claude, run `/clear` then `/help` | Slash commands work | ✅ pass | — |
| 9 | Kill terminal pane, spawn new one | Old PTY cleaned up, new one works | ✅ pass | — |
| 10 | Spawn 2 PTYs simultaneously | Independent I/O | ✅ pass | — |

---

## Risks & open questions for operator review

### Test 6 — `claude` TUI rendering (the gate)

This is the single test that decides whether the migration plan proceeds. If
the TUI shows any of:

- **Cursor stuck at top-left**, prompts overprinting → likely an alt-screen
  buffer (DECSET 1049) issue inside xterm.js
- **Garbled UTF-8** for branded glyphs / spinners → encoding boundary; check
  that we are NOT decoding bytes to UTF-16 anywhere on the way in (currently
  we do raw `Uint8Array` → `term.write(bytes)`, which is correct)
- **No truecolor**, only 8 colors → `TERM=xterm-256color` and
  `COLORTERM=truecolor` are already injected in `pty/mod.rs`. If it still
  happens, claude is sniffing `terminfo` for an entry that doesn't exist on
  the host
- **Bracketed paste / focus events leaking as raw text** → xterm's defaults
  cover these; verify `allowProposedApi: true` is honored

If test 6 fails, the report flips to RED and the migration plan needs the
SDK-first pivot discussed in `00-overview.md` § Risk Register.

### Test 7–8 — stream-json format for phase 5 — VERIFIED 2026-04-30

Captured from real `claude -p "list files in this directory" --output-format stream-json --verbose` against `~/royalti-co/` using **Claude Code v2.1.123, Opus 4.7 (1M)**. The phase 3 doc's assumed schema (flat `text`/`tool_use`/`tool_result`/`thinking`/`session`/`done` events) is **wrong**. The real schema is the Anthropic API envelope shape. Phase 3 parser must be rewritten to match.

#### Real top-level event types

| Type | Subtype(s) | Frequency | Purpose |
|---|---|---|---|
| `system` | `init` | 1 (first) | Session bootstrap: `session_id`, `model`, `cwd`, `permissionMode`, `output_style`, slash commands list, mcp_servers, agents, supported_models. **Authoritative for session metadata** — emit our `SessionId` event from this, not from a separate `session` event |
| `system` | `hook_started`, `hook_response` | N pairs | SessionStart / etc. hooks. Adapter can ignore for chat UI; surface as system events for power-user diagnostics |
| `assistant` | — | N | Wraps a single Anthropic API message. The `message.content[]` array has `text`, `tool_use`, or `thinking` blocks |
| `user` | — | N | Wraps tool_result blocks (and any user input). `message.content[]` items have `{type:"tool_result", tool_use_id, content, is_error}` |
| `rate_limit_event` | — | 0..1 | Passthrough rate-limit info |
| `result` | `success`, `error` | 1 (last) | Final summary: `duration_ms`, `num_turns`, `result` (text), `stop_reason`, `total_cost_usd`, `usage` (full token + cache breakdown) |

#### Real assistant event shape

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_01...",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01...",
        "name": "Bash",
        "input": { "command": "ls", "description": "List files in current directory" },
        "caller": { "type": "direct" }
      }
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 6,
      "cache_creation_input_tokens": 50301,
      "cache_read_input_tokens": 0,
      "output_tokens": 0,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 50301 }
    }
  },
  "parent_tool_use_id": null,
  "session_id": "309fcec4-...",
  "uuid": "bf05127b-..."
}
```

Note: `parent_tool_use_id` exists on assistant/user events for **nested tool calls** (Task subagents). Phase 5's tool-call card UI should respect this for nested rendering.

#### Real user event shape (carries tool_result)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01...",
        "type": "tool_result",
        "content": "AE_December_2025_fuga_clean.csv\nCLAUDE.md\n...",
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "309fcec4-...",
  "uuid": "e0c1c8c8-...",
  "timestamp": "2026-04-30T16:01:53.357Z",
  "tool_use_result": {
    "stdout": "...",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

The structured Anthropic-style block is in `message.content[]`; a denormalized `tool_use_result` sits alongside (convenient for adapters that want stdout/stderr split). Either is valid; prefer `message.content[]` for canonical shape.

#### Real result event shape (terminal)

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 7028,
  "duration_api_ms": 6251,
  "num_turns": 2,
  "result": "Files listed above.",
  "stop_reason": "end_turn",
  "session_id": "309fcec4-...",
  "total_cost_usd": 0.351073,
  "usage": { "input_tokens": 7, "cache_creation_input_tokens": 51742, "cache_read_input_tokens": 50301, "output_tokens": 100, ... }
}
```

#### Required corrections to `04-phase-3-claude-sessions.md`

The "Map Claude's stream-json events" table in phase 3's spec must be replaced with the dispatch logic below:

```rust
// src-tauri/src/claude/stream_parser.rs
//
// Parse a single stream-json line. The CLI emits envelope events; we walk into
// .message.content[] for assistant/user blocks.

match event["type"].as_str() {
    Some("system") => match event["subtype"].as_str() {
        Some("init") => emit ChatEvent::SessionInit {
            session_id, model, cwd, permission_mode, slash_commands, agents, supported_models, ...
        },
        Some("hook_started") | Some("hook_response") => emit ChatEvent::SystemHook { ... }, // optional surface
        _ => emit ChatEvent::Unknown { raw: event },
    },

    Some("assistant") => {
        for block in event["message"]["content"].as_array() {
            match block["type"].as_str() {
                Some("text")     => emit ChatEvent::Text { delta: block["text"] },
                Some("tool_use") => emit ChatEvent::ToolUse {
                    id: block["id"], name: block["name"], input: block["input"],
                    parent_tool_use_id: event["parent_tool_use_id"]
                },
                Some("thinking") => emit ChatEvent::Thinking { delta: block["thinking"] },
                _ => emit ChatEvent::Unknown { raw: block },
            }
        }
        // Per-message usage available at event["message"]["usage"] for cost tracking.
    },

    Some("user") => {
        for block in event["message"]["content"].as_array() {
            if block["type"] == "tool_result" {
                emit ChatEvent::ToolResult {
                    id: block["tool_use_id"],
                    output: block["content"],
                    is_error: block["is_error"].as_bool().unwrap_or(false),
                    parent_tool_use_id: event["parent_tool_use_id"],
                }
            }
        }
    },

    Some("rate_limit_event") => emit ChatEvent::RateLimit { ... }, // optional

    Some("result") => emit ChatEvent::Done {
        usage: event["usage"], cost: event["total_cost_usd"],
        stop_reason: event["stop_reason"], duration_ms: event["duration_ms"]
    },

    _ => emit ChatEvent::Unknown { raw: event },
}
```

#### Notes for the operator

- The capture used `--verbose` (required when `-p` is combined with `--output-format stream-json`). Phase 3 spawn args must include `--verbose`.
- Streaming text deltas weren't seen in this run because the assistant went straight to `tool_use`. Try `--include-partial-messages` to capture mid-message text deltas if needed for typewriter UX in phase 5.
- The `system:init` event is HUGE (slash_commands + agents + mcp_servers + supported_models). Don't blindly forward to the chat UI — extract `session_id`, `model`, `cwd` and ignore the rest unless building a power-user inspector.
- Hooks in this monorepo fired 3 SessionStart hooks per session. If you don't want hook noise in chat, filter `system:hook_*` at the parser; if you want a "session details" sidebar, surface them.
- The capture cost **$0.35** in API spend (Opus 4.7, 50K cache creation tokens). Be aware that `claude -p` runs are real money — keep phase 5 contract tests minimal.

### WebGL on Linux

`@xterm/addon-webgl` construction is wrapped in `try/catch` and a context-loss
handler. On the WebKitGTK 2.50 sandbox here, EGL falls back to software
rendering (`libEGL warning: DRI3 error`) — that's a host concern, not an app
concern. On a real Linux desktop with hardware DRI3 the addon should attach
cleanly; if it doesn't, the toolbar status will show `webgl unavailable —
canvas renderer` and the terminal continues to render via canvas. Per spec,
that scenario remains YELLOW, not RED.

### macOS PATH for `claude`

`pty/mod.rs` calls `std::env::vars()` and forwards every parent-process env
var into the spawned child *before* layering our `TERM` defaults. On macOS,
`tauri dev` inherits the shell PATH, so `claude` should resolve. If the
operator runs the **bundled** `.app` from Finder instead of `tauri dev`, GUI
apps on macOS get a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`); in that
case `claude` would not be found. Mitigation for phase 8: read the user's
default shell, source `~/.zprofile`, or hardcode common dev paths
(`/opt/homebrew/bin`, `~/.local/bin`, `~/.cargo/bin`). Out of scope for this
spike.

---

## Implementation notes worth carrying into phase 1

1. **Bytes across the IPC boundary are base64.** Tauri 2 events serialize
   payloads as JSON, and `Uint8Array` round-trips poorly. The Rust emitter in
   `src-tauri/src/pty/mod.rs` base64-encodes each chunk; the receiver in
   `src/lib/tauri-cmd.ts` decodes back to `Uint8Array` before
   `term.write(bytes)`. This costs ~33% bandwidth on PTY chunks vs raw bytes.
   If that becomes a bottleneck (huge `find /` floods), switch to a custom
   command channel with `tauri::ipc::Response::new(Vec<u8>)` or use
   tauri-plugin-shell's binary stream support.

2. **Reader thread is blocking; emitter is async.** `portable-pty`'s reader
   doesn't expose a non-blocking interface, so we run it in a `std::thread`
   and bridge to tokio via `mpsc::channel`. The emitter task batches at ~120 Hz
   to stay under the threshold where Tauri events drop under sustained load.

3. **Env inheritance is explicit.** portable-pty does NOT inherit env by
   default. We copy `std::env::vars()` first, then layer caller-supplied env,
   then force `TERM=xterm-256color` and `COLORTERM=truecolor`. Any phase-1
   refactor must preserve that order or `claude` regresses on color.

4. **Kill is idempotent.** Repeatedly calling `pty_kill` on the same id is a
   no-op after the first call (the dashmap entry is removed when the child
   waiter reaps). The frontend cleanup in `xterm-host.tsx` relies on this.

5. **Capabilities are minimal.** `src-tauri/capabilities/default.json` only
   grants `core:default`, event/window/webview defaults. The custom
   `pty_*` commands inherit access through `tauri::generate_handler!` and
   don't need a permission file (Tauri 2 commands are allowed by default
   unless explicitly denied). Phase 1 will need to add fs scope for
   `~/royalti-co/**`, `~/.claude/projects/**`, `~/.company/**` per the
   architecture doc.

---

## What's intentionally NOT here (per spec)

- Stronghold, updater plugin, `tauri-plugin-sql` — phases 1–3
- App shell, routing, Supabase, viewer, chat adapters — phases 1–5
- Code signing, notarization — phases 8–9
- Any modification to existing `ikenga/` — phase 1+
- Anything from `royalti-video-engine/` — phases 6–7 only

---

## Operator next steps

1. `cd ikenga-desktop && bun install && bunx tauri dev`
2. Walk the 10 acceptance tests above, fill in the `Result` column.
3. Run the stream-json capture command (§ Risks) and paste real output here.
4. If all 10 pass and TUI looks right → flip the verdict to **GREEN** at the
   top of this file and merge the PR.
5. If test 6 fails → flip to **RED**, leave PR open, ping back for a pivot.
6. If 1–5 + 7–10 pass but a non-critical quirk shows up (e.g. webgl falls
   back to canvas) → keep **YELLOW**, document the quirk, merge anyway.
