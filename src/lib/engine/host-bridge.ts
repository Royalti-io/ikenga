// Shell-side `HostBridge` wiring for the Claude Code engine adapter.
//
// The engine pkg (`@ikenga/pkg-engine-claude-code`) is a headless adapter that
// implements the `Engine` interface from `@ikenga/contract/engine`. It does
// not call `invoke()` directly — it talks to the host shell through this
// `HostBridge`, which adapts each engine-level operation onto the shell's
// existing `claude_chat_*` Tauri commands.
//
// Two concerns this file handles:
//
//   1. Session id translation. The engine generates its own UUID for each
//      session (`crypto.randomUUID()` inside `ClaudeCodeEngine.startSession`)
//      and uses it as the stable `Session.id`. The shell's
//      `claudeChatSpawn` returns a *placeholder* uuid that is later replaced
//      by the real Claude Code session id (arriving on the first
//      `session_init` event). Both ids fan-in to the same backend channel
//      because Rust re-emits events on `claude://session/{placeholderId}`
//      AND `claude://session/{realId}`. We map engine-id → placeholder id
//      and use the placeholder for `send` / `kill` / `listen`.
//
//   2. Event shape translation. The shell emits a richer `ChatEvent` union
//      tagged by `kind`. The engine contract's `EngineEvent` is tagged by
//      `type` and is a strict subset (text/tool/thinking/usage/done). The
//      mapper below converts the overlap and treats unmapped variants as
//      best-effort `done` or pass-through silence (see comments inline).

import {
  claudeChatKill,
  claudeChatSend,
  claudeChatSpawn,
  claudeListenSession,
  type ChatEvent,
  type ClaudeOpts,
} from "@/lib/tauri-cmd";
import type {
  EngineEvent,
  McpServerSpec,
} from "@ikenga/contract/engine";
import type { HostBridge } from "@ikenga/pkg-engine-claude-code";

interface SessionRecord {
  /** Placeholder id returned by `claudeChatSpawn`. Used for all subsequent
   *  Tauri calls because the backend re-emits events on this id. */
  placeholderId: string;
  /** Working directory used at spawn time. */
  cwd: string;
}

/**
 * Map an engine-supplied uuid to the placeholder id returned by
 * `claudeChatSpawn`. Module-level because `HostBridge` is a singleton and
 * the kernel constructs exactly one engine instance.
 */
const sessions = new Map<string, SessionRecord>();

/**
 * Convert the shell's wire-format `ChatEvent` to the contract's
 * `EngineEvent`. Returns `null` when the event has no engine-level
 * representation (e.g. artifacts, system hooks, parse errors) — the iterator
 * skips those rather than fabricating data.
 */
export function chatEventToEngineEvent(event: ChatEvent): EngineEvent | null {
  switch (event.kind) {
    case "text":
      return { type: "message_delta", text: event.delta };
    case "thinking":
      return { type: "thinking_delta", text: event.delta };
    case "tool_use":
      return {
        type: "tool_use",
        tool: event.name,
        input: event.input,
        toolUseId: event.id,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: event.id,
        output: event.output,
        isError: event.isError,
      };
    case "done": {
      // The shell emits richer telemetry on `done` (usage, totalCostUsd,
      // durationMs). The engine contract only carries usage tokens — we'd
      // need a separate `usage` event for that. For now collapse to a single
      // `done` and emit usage upstream of this mapper if the shape is known.
      const reason: EngineEvent & { type: "done" } = {
        type: "done",
        reason: event.stopReason === "cancelled" ? "cancel" : "stop",
      };
      return reason;
    }
    case "rate_limit":
      return {
        type: "done",
        reason: "error",
        error: "rate_limited",
      };
    case "parse_error":
      return {
        type: "done",
        reason: "error",
        error: `parse_error: ${event.message}`,
      };
    // session_init, artifact, system_hook, unknown: no engine equivalent.
    case "session_init":
    case "artifact":
    case "system_hook":
    case "unknown":
      return null;
    default: {
      // Exhaustiveness guard — TS will flag if a new ChatEvent kind is added.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Bridge `claudeListenSession` (a Tauri event subscription with a callback)
 * into an `AsyncIterable<EngineEvent>` that completes on `done`. Buffers
 * events between iterator pulls so nothing is dropped if the consumer is
 * slow.
 */
function listenAsAsyncIterable(
  placeholderId: string,
): AsyncIterable<EngineEvent> {
  return {
    [Symbol.asyncIterator]() {
      // Pending events waiting for the next iterator pull.
      const queue: EngineEvent[] = [];
      // Pull-side promise resolver, set when iterator awaits with empty queue.
      let resolveNext: ((ev: IteratorResult<EngineEvent>) => void) | null =
        null;
      let done = false;
      let unlistenPromise: Promise<() => void> | null = null;

      const push = (ev: EngineEvent) => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: ev, done: false });
        } else {
          queue.push(ev);
        }
        if (ev.type === "done") {
          done = true;
          // Tear down the listener once the engine 'done' has been delivered.
          unlistenPromise?.then((u) => u()).catch(() => {});
        }
      };

      unlistenPromise = claudeListenSession(placeholderId, (chatEvent) => {
        const mapped = chatEventToEngineEvent(chatEvent);
        if (mapped) push(mapped);
      });

      return {
        async next(): Promise<IteratorResult<EngineEvent>> {
          if (queue.length > 0) {
            const value = queue.shift() as EngineEvent;
            return { value, done: false };
          }
          if (done) {
            return { value: undefined, done: true };
          }
          return new Promise<IteratorResult<EngineEvent>>((resolve) => {
            resolveNext = resolve;
          });
        },
        async return(): Promise<IteratorResult<EngineEvent>> {
          done = true;
          unlistenPromise?.then((u) => u()).catch(() => {});
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Construct a `HostBridge` adapter over the shell's Tauri commands.
 * Exported as a factory so tests can swap individual methods or stub the
 * whole surface.
 */
export function createShellHostBridge(): HostBridge {
  return {
    async spawn(opts) {
      const claudeOpts: ClaudeOpts = {
        // The contract's `systemPrompt` doesn't have a direct ClaudeOpts
        // analogue — `claude` honors a system prompt via the `prompt` arg
        // at spawn time. Passing as the initial prompt mirrors how the
        // shell's existing chat code primes a session.
        prompt: opts.systemPrompt,
        resumeSessionId: opts.resumeSessionId,
        model: opts.model,
      };
      // `claudeChatSpawn` requires a cwd. Default to '.' (resolved by the
      // Rust side relative to app cwd) when the engine caller didn't supply
      // one. Real callers always pass cwd from the pkg manifest.
      const cwd = opts.cwd ?? ".";
      const result = await claudeChatSpawn(cwd, claudeOpts);
      sessions.set(opts.sessionId, {
        placeholderId: result.sessionId,
        cwd,
      });
    },

    async send(sessionId, message) {
      const rec = sessions.get(sessionId);
      if (!rec) {
        throw new Error(`engine bridge: unknown session ${sessionId}`);
      }
      await claudeChatSend(rec.placeholderId, message);
    },

    async kill(sessionId) {
      const rec = sessions.get(sessionId);
      if (!rec) return; // idempotent
      try {
        await claudeChatKill(rec.placeholderId);
      } finally {
        sessions.delete(sessionId);
      }
    },

    listen(sessionId) {
      const rec = sessions.get(sessionId);
      if (!rec) {
        // Return an iterable that immediately yields a done/error so callers
        // don't hang waiting for events on an un-spawned session.
        return {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next(): Promise<IteratorResult<EngineEvent>> {
                if (yielded) return { value: undefined, done: true };
                yielded = true;
                return {
                  value: {
                    type: "done",
                    reason: "error",
                    error: `unknown session ${sessionId}`,
                  },
                  done: false,
                };
              },
            };
          },
        };
      }
      return listenAsAsyncIterable(rec.placeholderId);
    },

    async registerMcp(_spec: McpServerSpec) {
      // TODO(phase-engine): wire to a `claude_mcp_register` Tauri command
      // once the Rust side gains an MCP registry tied to live `claude` CLI
      // children. Today MCP servers are configured via `~/.claude/mcp.json`
      // out-of-band, so the engine's runtime registration is a no-op.
      return;
    },

    async unregisterMcp(_id: string) {
      // TODO(phase-engine): pair with `registerMcp` above.
      return;
    },
  };
}
