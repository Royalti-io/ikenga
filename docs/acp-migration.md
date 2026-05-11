# ACP migration — chat engine rewrite

**Status:** Phases 1–11 complete (2026-05-11). Phase 12 deferred.

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
| 1 | Rust ACP crate + skeleton Agent impl | ✅ landed | `c238255` |
| 2 | `stream_parser` → `SessionUpdate` mapping | ✅ landed | `920bdde` |
| 3 | Prompt handling — first real chat over ACP | ✅ landed | `3d45e65` |
| 4 | `--permission-prompt-tool stdio` + AskUserQuestion fix | ✅ landed | (this commit) |
| 5 | Session modes (plan/default/auto/bypassPermissions) | ✅ landed | (this commit) |
| 6 | Interrupt via control_request | ✅ landed | (this commit) |
| 7 | Image input via ACP content blocks | ✅ landed | (this commit) |
| 8 | Session `/branch` (ACP `fork`) + faster resume | ✅ landed | (this commit) |
| 9 | Notification + PermissionRequest hooks → OS | ✅ landed | (this commit) |
| 10 | Reshape `@ikenga/contract/engine` around ACP | ✅ landed | (this commit) |
| 11 | Retire band-aids + maybe drop `chat_user_turns` | ✅ landed | (this commit) |
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

## Phase 10 — Reshape `@ikenga/contract/engine` around ACP ✅

**Delivered:**

- `@ikenga/contract/engine` (TS) — new ACP-shaped surface added alongside the
  legacy `Engine` interface. Types mirror ACP method shapes verbatim:
  `AcpInitializeRequest/Response`, `AcpNewSessionRequest/Response`,
  `AcpPromptRequest/Response`, `AcpSessionUpdate`, `AcpPermissionRequest*`,
  `AcpForkResult`, `AcpLoadSessionResponse`, `AcpNotifyPayload`, and the
  `AcpEngine` adapter interface itself (newSession / prompt / cancel /
  setMode / loadSession / forkSession / onSessionUpdate /
  onPermissionRequest / respondPermission / onNotify). The legacy
  `Engine` / `AgentCapabilitiesSchema` / `EngineProvidesSchema` shapes
  stay intact — Phase 11 retires them.
- `pkgs/engine-claude-code/` — added `src/acp-engine.ts` exporting
  `createAcpEngine(host: AcpHost)`. The pkg stays free of `@tauri-apps/*`
  deps; the shell injects an `AcpHost` from its `tauri-cmd.ts` wrappers
  (duplicate-vs-share decision: **path (a)** per the Phase 10 brief —
  host-injection over re-export, so the pkg boundary stays clean).
- `shell/src/lib/engine/host-bridge.ts` — `createShellAcpHost()` factory
  binds the engine pkg to the shell's `acp*` wrappers
  (`acpInitialize`/`acpNewSession`/`acpPrompt`/`acpCancel`/`acpSetMode`/
  `acpLoadSession`/`acpForkSession`/`acpListen`/`acpListenRequests`/
  `acpRespondPermission`/`acpListenNotify`).
- `shell/src/lib/engine/index.ts` — `getAcpEngine()` singleton sits next
  to the existing `getEngine()`. Tests can swap via
  `createAcpEngineFromHost(fakeHost)`.
- `shell/src/chat/adapters/acp.ts` — new `AcpAdapter` implements the
  existing `ChatAdapter` interface but routes through ACP under the hood.
  Translates `AcpSessionUpdate` → legacy `ChatEvent` at the adapter
  boundary so the store / Thread / ToolCallCard renderers stay unchanged.
- Default flip — `shell/src/chat/default-adapter.ts` exports
  `defaultChatAdapterId()`. `useThread` + `useChatActions` use it for
  new-thread defaults; `Composer` + `Thread` flip `acpEnabled = true` by
  default. The dedicated `/sessions/$sessionId` route + the pane
  `chat-view.tsx` both inherit the new default automatically.
- **Feature flag:** `localStorage.ikenga_chat_engine`. Values:
  - unset / `'acp'` (default) → use the new `AcpAdapter`.
  - `'legacy'` or `'cli'` → use the legacy `ClaudeCliAdapter`. Retained
    for one release.

**TODO(phase-11) notes left in the code:**

- `chat/adapters/acp.ts` — collapse the `AcpSessionUpdate → ChatEvent`
  translation once the legacy adapter is retired; have the store consume
  `AcpSessionUpdate` directly.
- `chat/ui/thread.tsx` + `chat/ui/composer.tsx` — drop the `acpEnabled`
  prop entirely.
- `pkgs/engine-claude-code` `src/index.ts` — drop the legacy
  `createEngine` / `HostBridge` / `ClaudeCodeEngine` / `Engine`
  implementation once the legacy adapter is retired.

---

## Phase 11 — Retire band-aids ✅

**Delivered (2026-05-11):**

- **AskUserQuestion auto-error fallback dropped** —
  `shell/src/chat/ui/tool-renderers/ask-user-question.tsx` shrank from
  ~380 lines to ~115. The renderer is now a read-only view: it shows the
  question + options without any submit affordance, and flags that the
  ACP `PermissionDialog` handles this tool on the default engine. The
  legacy `tool_result` + follow-up `sessionSend` workaround is gone.
- **Follow-up-message workaround dropped** — same file. The
  `appendUserTurn + sessionSend` follow-up that piggybacked on the
  auto-error branch was deleted with the auto-error code.
- **`chat_user_turns` table KEPT** — audit conclusion: ACP's
  `user_message_chunk` is not emitted by our `AcpServer` (the prompt
  handler only forwards agent-side ChatEvents back to the frontend), and
  the JSONL `dispatch_user` in `stream_parser.rs` drops plain-string
  user messages (only `tool_result` blocks survive). So
  `chat_user_turns` remains the source of truth for the user's
  transcript half. Documented in `shell/src/chat/persist.ts` and the
  migration file `0011_chat_sessions.sql`. No `0013` migration shipped.
- **`session_send` (+ siblings) KEPT, with retirement TODO** —
  intentional Phase-11 scope cut. Non-chat call sites still depend on
  the legacy `session_*` commands: `routes/install.tsx`,
  `shell/dock/dock.tsx`, `shell/panes/new-tab-menu.tsx`,
  `shell/sessions/new-session-dialog.tsx`,
  `routes/sessions/$sessionId/index.tsx`, and the legacy
  `lib/engine/host-bridge.ts`. Each would need its own ACP migration
  (lazy session creation + a non-prompt "ensure thread row" route).
  Tracked as `TODO(phase-12)` — the chat path itself does not need
  these, but they're load-bearing for the install + sidebar flows.
- **`user_turn` ChatEvent variant KEPT (frontend-only)** — no Rust
  emitter ever produces this variant; it is synthesized in the
  frontend (`hooks.ts::useChatActions.send`,
  `persist.ts::loadUserTurns` merge, and the now-shrunken
  `new-session-dialog.tsx`). Cleanup not warranted — the variant
  remains because it is the transport for user-turn echoes from
  `chat_user_turns` into the render store. No
  `system_hook(user_message)` variant exists in `event.rs`; the doc's
  reference was speculative.
- **`acpEnabled` prop dropped entirely** — removed from
  `shell/src/chat/ui/composer.tsx` and `shell/src/chat/ui/thread.tsx`.
  All gated branches now execute unconditionally. No external caller
  was passing the prop — Phase 10 had already made it default-true.

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
