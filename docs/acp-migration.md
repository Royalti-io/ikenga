# ACP migration — chat engine rewrite

**Status:** Phase 1 complete (2026-05-11). Phases 2–11 pending. Phase 12 deferred.

## Decision

Ikenga's chat backend is becoming a **Rust implementation of the Agent
Client Protocol (ACP)**, in-process to the Tauri app, wrapping the user's
existing `claude` binary via `claude --print --input-format stream-json
--output-format stream-json --permission-prompt-tool stdio`.

Memory features (`CLAUDE.md` hierarchy, auto-memory `~/.claude/projects/<hash>/memory/MEMORY.md`,
`/memory` slash, `#` shortcuts, `/compact`, `--resume`, session JSONL) come
from the `claude` binary itself. We do **not** depend on
`@anthropic-ai/claude-agent-sdk` (the Node SDK) or
`@agentclientprotocol/claude-agent-acp` (the official ACP adapter). That
keeps us +~5 MB binary / +~15 MB RSS vs +255 MB / +80–120 MB RSS for the
node-based path. Full reasoning in `~/.claude/.../memory/project_acp_engine_decision.md`.

## Why ACP (not stream-json + targeted patches)

- **Wire-compatible with the broader registry** — 36 ACP-compatible agents
  exist today (Codex CLI, Copilot CLI, Gemini CLI, Cursor, Goose, Kimi,
  Qwen, OpenCode, Mistral, etc.). Future non-Claude agents become
  npm-install adapters instead of bespoke integrations.
- **The features we want are already in the spec** — tool approval, plan
  mode, interrupt, image input, fork (`/branch`), resume, MCP server
  forwarding, notifications. We plumb each once at the ACP layer.
- **No new band-aids** — `AskUserQuestion` becomes a real `session/request_permission`
  round-trip instead of our auto-error + follow-up-message workaround.

## What we keep

- `src-tauri/src/claude/` — `session.rs`, `stream_parser.rs`,
  `jsonl_reader.rs`, `event.rs` become the implementation **behind** the
  ACP server. Stable, well-tested foundation.
- `chat_user_turns` table — may still be useful as a local echo log; revisit in Phase 11.
- The `Session { thread_id, streaming, pty_id, claude_session_id, cwd, opts }` model.
- Existing UI: `Composer`, `Thread`, `ToolCallCard`, individual tool
  renderers. These shift from listening to our custom event types to
  listening to ACP `SessionUpdate` types — but the shape is similar.

## What we retire

- Custom `claude_chat_*` Tauri commands → ACP method handlers.
- Follow-up-message workaround for `AskUserQuestion` (Phase 4).
- The `--dangerously-skip-permissions` blanket on every spawn (Phase 5).
- The "kill the child" Cancel button (Phase 6 — clean interrupt).
- The synthetic `user_turn` event kind in `ChatEvent`, *if* ACP's
  `user_message_chunk` covers it (Phase 11).

## Phases

Each phase is a separate testable commit. Earlier phases land while the
existing chat keeps working — the new ACP path is feature-flagged until
Phase 10 reshapes the contract.

| # | Phase | Status | Branch / commit |
|---|---|---|---|
| 1 | Rust ACP crate + skeleton Agent impl | ✅ landed | `feat/onboarding-wizard` |
| 2 | `stream_parser` → `SessionUpdate` mapping | pending | |
| 3 | Prompt handling — first real chat over ACP | pending | |
| 4 | `--permission-prompt-tool stdio` + AskUserQuestion fix | pending | |
| 5 | Session modes (plan/default/auto/bypassPermissions) | pending | |
| 6 | Interrupt via control_request | pending | |
| 7 | Image input via ACP content blocks | pending | |
| 8 | Session `/branch` (ACP `fork`) + faster resume | pending | |
| 9 | Notification + PermissionRequest hooks → OS | pending | |
| 10 | Reshape `@ikenga/contract/engine` around ACP | pending | |
| 11 | Retire band-aids + maybe drop `chat_user_turns` | pending | |
| 12 | Registry-of-agents plumbing (Codex/Aider/etc.) | deferred | |

---

## Phase 1 — Rust ACP crate + skeleton Agent impl ✅

**Goal:** prove the `agent-client-protocol` crate compiles into our build
and we own a stable type vocabulary.

**Delivered:**
- `agent-client-protocol = { version = "0.11", features = ["unstable"] }` in `Cargo.toml`
- `src-tauri/src/acp/mod.rs` — module entry with link-test
- `src-tauri/src/acp/server.rs` — `AcpServer` struct + `handle_initialize`
  advertising `image`, `embedded_context`, `http` + `sse` MCP, `load_session`
- Unit tests: 3 passing

---

## Phase 2 — `stream_parser` → `SessionUpdate` mapping

**Goal:** translate every `claude::event::ChatEvent` variant our parser
emits today into the equivalent ACP `SessionUpdate` notification. No
session/prompt wiring yet — this is just the pure function layer.

**Files to create:**
- `src-tauri/src/acp/mapping.rs` — `fn chat_event_to_session_updates(event: &ChatEvent) -> Vec<SessionUpdate>`. Some events expand 1→N (e.g. `session_init` triggers `current_mode_update` + `available_commands_update`); some collapse N→1.

**Mapping table (canonical):**

| `ChatEvent` | `SessionUpdate` | Notes |
|---|---|---|
| `Text { delta, message_id }` | `AgentMessageChunk { content: text(delta) }` | message_id surfaces via `_meta` for now |
| `Thinking { delta, .. }` | `AgentThoughtChunk { content: text(delta) }` | |
| `ToolUse { id, name, input, parent }` | `ToolCall { id, title, kind, status: pending, content }` | initial event |
| `ToolResult { id, output, is_error, .. }` | `ToolCallUpdate { id, status: completed/failed, content }` | follow-up |
| `Artifact { path, mime, .. }` | `ToolCallUpdate { id, content: [diff/embedded_resource] }` | bundle with the producing tool's update |
| `SystemHook { hook_event, .. }` | _meta passthrough or drop | most hooks are diagnostic; PreToolUse / PermissionRequest fork to Phase 9 |
| `RateLimit { info }` | `UsageUpdate { .. }` or drop | |
| `Done { usage, total_cost_usd, .. }` | terminates the `session/prompt` response; emits final `UsageUpdate` | not a SessionUpdate per se |
| `ParseError`, `Unknown` | log + drop | |

**Tests:**
- Golden transcript files in `src-tauri/src/acp/test-fixtures/`. Feed
  each fixture through `stream_parser`, then through the mapper, assert
  the output sequence.

**Deliverable:** `cargo test --lib acp::mapping::tests` green.

---

## Phase 3 — Prompt handling: first real chat over ACP

**Goal:** end-to-end ACP `session/prompt` → assistant text streaming
back. Both the old `session_send` Tauri command and the new ACP path
coexist behind a feature flag.

**Files to create:**
- `src-tauri/src/acp/prompt.rs` — converts ACP `PromptRequest.prompt: Vec<ContentBlock>` into a stream-json user envelope; routes through existing `claude::session::send_user_message`.
- `src-tauri/src/commands/acp.rs` — new Tauri commands: `acp_initialize`, `acp_new_session`, `acp_prompt`, `acp_cancel`. Wires the `AcpServer` into the invoke handler.
- `src/lib/tauri-cmd.ts` — typed wrappers: `acpInitialize`, `acpNewSession`, `acpPrompt`, `acpCancel`.

**Events:** Tauri emits ACP notifications on `acp://session/{threadId}` — the frontend listener decodes them as `SessionUpdate` payloads.

**Feature flag:** `localStorage.ikenga_chat_engine = 'acp' | 'legacy'`. Default `legacy` until Phase 10.

**Manual test:** with the flag set, open a chat, send "Hello", verify
assistant text streams back through the new path. Use iyke.

---

## Phase 4 — `--permission-prompt-tool stdio` + AskUserQuestion fix

**Goal:** Claude no longer auto-errors `AskUserQuestion`. Tool approval
is a real round-trip.

**Plumbing:**
- Spawn claude with `--permission-prompt-tool stdio`.
- New `claude::session::handle_control_request` — parse `sdk_control_request` envelopes from stdout. Subtype `permission` carries `tool_name + tool_input`. For `AskUserQuestion`, surface as ACP `session/request_permission` to the client. For any other tool, ditto with the appropriate `kind`.
- Client replies with `RequestPermissionResponse { outcome: selected | cancelled }`. Server translates into a `control_response { behavior, updatedInput }` and writes to stdin.
- `AskUserQuestion`: `updatedInput.answers = { question: value, ... }` per the tool's spec.

**UI changes:**
- `PermissionDialog` component, replaces the band-aid `AskUserQuestionRenderer` for the real flow.
- Drop the auto-error → follow-up-message fallback in `ask-user-question.tsx`.

**Test (iyke):** prompt Claude to ask a question via `AskUserQuestion`; verify form renders, user picks, Claude continues with a real `tool_result`.

---

## Phase 5 — Session modes

**Goal:** plan mode + auto mode are first-class. Drop the
`--dangerously-skip-permissions` blanket.

- `session/new` response includes `modes.currentModeId` + `modes.availableModes` (advertised by `claude-agent-acp` we observed in the prototype).
- `session/set_mode` Tauri command writes `control_request { subtype: "set_permission_mode" }` to stdin.
- Composer gains a mode picker (badge + dropdown).

---

## Phase 6 — Interrupt

**Goal:** clean cancel that preserves transcript.

- ACP `session/cancel` notification → `control_request { subtype: "interrupt" }` to claude stdin.
- Old "kill the child" path goes away.
- Test: start a long bash, click Stop, transcript stays intact, next turn works.

---

## Phase 7 — Image input

**Goal:** paste/drop an image into the composer, Claude analyzes it.

- ACP `ContentBlock::Image { mime_type, data: base64, uri? }` in `session/prompt`.
- Composer accepts paste (`ClipboardEvent`) + drag/drop (`onDrop`). Convert to base64 client-side; pass through Tauri.
- Backend formats as stream-json image content block.

**Verified by smoke test:** `promptCapabilities.image: true` is advertised by claude. Streaming-input mode supports images; single-message mode does not.

---

## Phase 8 — Session `/branch` + faster resume

- ACP `session/fork` — clone a session from a chosen turn.
- Migration `0012_session_fork.sql`: `chat_threads.branched_from TEXT REFERENCES chat_threads(id)`.
- UI: "Branch from here" action on assistant rows; new thread inherits transcript up to that point.
- Resume uses ACP `session/resume`. Confirm latency vs current cold spawn.

---

## Phase 9 — Notification + PermissionRequest hooks → OS

- Listen for `Notification` and `PermissionRequest` hook firings via stream-json.
- OS notification (`tauri-plugin-notification` or `set_dock_badge`) when Claude wants attention and the app is unfocused.
- Thread row badge in the sidebar when the user is in a different pane.

---

## Phase 10 — Reshape `@ikenga/contract/engine` around ACP

- `@ikenga/contract/engine` TS types mirror ACP method shapes (newSession, prompt, cancel, setMode, requestPermission).
- `pkgs/engine-claude-code/` becomes a thin pkg exposing the ACP server.
- `host-bridge.ts` becomes the Tauri-side wire to the Rust ACP server.
- Existing `useChatActions` + `useThread` adapt to the new shape.
- Feature flag (Phase 3) flips to default `acp`. Legacy path retained for one release.

---

## Phase 11 — Retire band-aids

- Drop the `AskUserQuestion` auto-error fallback (Phase 4 fixed the root cause).
- Drop the follow-up-message workaround.
- Audit `chat_user_turns`: if ACP `user_message_chunk` carries our writes back to us, drop the table (migration 0013). Otherwise keep as authoritative echo log.
- Delete the `session_send` Tauri command, the `system_hook(user_message)` event variant, and any related dead code.

---

## Phase 12 — Registry-of-agents plumbing (deferred)

- New pkg type `acp-sidecar` in the engine pkg system. Spawns a Node-based ACP adapter (e.g. `@agentclientprotocol/codex-acp`) as a subprocess and routes JSON-RPC over stdio.
- ACP client side stays the same — the Tauri shell doesn't know whether it's talking to in-process Rust ACP or out-of-process Node ACP.
- Out of scope for the main migration. Gate behind a feature flag until the Claude path is solid.

---

## Open questions

- **`memory_recall` events** — claude-agent-acp swallows them. Should we
  emit them as ACP `_meta` extensions, or as plain text inserts, or as a
  new SDK extension? Watch the upstream issue, mirror their decision when
  they make one.
- **Tool-call IDs in nested Task subagents** — ACP doesn't have a
  built-in hierarchy concept like our `parentToolUseId`. Use `_meta` for
  the relationship, or render flat. TBD when we hit it in Phase 2.
- **Streaming-input mode vs `--input-format stream-json` quirks** —
  documented inconsistency around stdin EOF behavior across claude
  versions. Our spawn already handles this; carry the same idiom into
  the ACP path.

## How to work this doc

- Each phase is a sub-task that an agent can pick up independently. The
  "Files to create" + "Tests" + "Deliverable" sections are the contract.
- Update the status table at the top after each phase lands.
- If a phase blocks on a finding (e.g. claude version compat), document
  it inline and move on.
- Keep the doc honest about retirements: anything we said we'd drop
  must actually be deleted in the phase that retires it, otherwise the
  next phase has stale baggage.
