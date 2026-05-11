/**
 * ClaudeCliAdapter — chat backend over Claude Code's streaming-input mode.
 *
 * Transport: ONE long-lived `claude --print --input-format stream-json
 * --output-format stream-json --verbose [--resume <id>]` child per chat
 * thread, connected via piped stdin/stdout (NOT a PTY — claude rejects
 * stream-json over a TTY). The Rust side owns spawn / send / cancel; this
 * adapter is a thin wrapper around `sessionEnsure` / `sessionSend` /
 * `sessionCancel` plus a `sessionListen` subscription that writes parsed
 * events directly into the store.
 *
 * v2 design notes (vs the bug-laden v1):
 *   - `threadId` is the only id the adapter handles. Claude's session id is
 *     metadata captured from `session_init` events; the URL never moves.
 *   - Live events flow `Rust → session://{threadId} → store.appendEvents`.
 *     No queue/store split, no placeholder→real alias dance.
 *   - One subscription per thread, attached the first time `send` is called
 *     and kept alive until `destroy()` (or `sessionCancel` from outside).
 */

import { Zap } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  sessionCancel,
  sessionDestroy,
  sessionEnsure,
  sessionListen,
  sessionSend,
  claudeListSessions,
  type ChatEvent,
} from '@/lib/tauri-cmd';
import { useChatStore } from '../store';
import { updateThreadMeta } from '../persist';
import type {
  AdapterCapabilities,
  AdapterContext,
  ChatAdapter,
  ChatInput,
  ChatThread,
  ModelOption,
} from '../adapter';

const CAPABILITIES: AdapterCapabilities = {
  toolCalls: true,
  artifacts: true,
  fileAttachments: true,
  imageInput: false,
  slashCommands: true,
  modelSwitching: false,
  streaming: true,
  promptCaching: true,
  agenticTools: true,
};

interface ActiveStream {
  threadId: string;
  unlisten: UnlistenFn | null;
}

class ClaudeCliAdapterImpl implements ChatAdapter {
  readonly id = 'cli';
  readonly label = 'Claude CLI';
  readonly Icon = Zap;
  readonly models: ModelOption[] | null = null;
  readonly capabilities = CAPABILITIES;

  /** One subscription per thread. Keyed by threadId so re-mounts don't
   *  double-subscribe (and so `destroy()` can tear them all down). */
  private streams = new Map<string, ActiveStream>();

  async init(_ctx: AdapterContext): Promise<void> {
    // No API key needed — claude CLI authenticates itself.
  }

  /** Ensure the Rust-side Session exists and a subscription is attached.
   *  Idempotent; safe to call from a hook on every mount. */
  async attach(threadId: string, cwd: string): Promise<void> {
    if (this.streams.has(threadId)) return;
    await sessionEnsure(threadId, cwd, {});
    const placeholder: ActiveStream = { threadId, unlisten: null };
    this.streams.set(threadId, placeholder);
    try {
      const unlisten = await sessionListen(threadId, (event) =>
        this.onEvent(threadId, event),
      );
      placeholder.unlisten = unlisten;
    } catch (e) {
      this.streams.delete(threadId);
      throw e;
    }
  }

  private onEvent(threadId: string, event: ChatEvent) {
    const store = useChatStore.getState();
    const existing = store.threads[threadId];
    if (!existing) return; // store row not hydrated yet — drop on the floor

    // Capture the real Claude session id once so the on-disk JSONL is
    // reachable for replays. Doesn't change the route — threadId is stable.
    if (event.kind === 'session_init' && event.sessionId) {
      const stored = existing.thread.claudeSessionId;
      if (event.sessionId !== stored) {
        store.setThread(threadId, { claudeSessionId: event.sessionId });
        void updateThreadMeta(threadId, { claudeSessionId: event.sessionId });
      }
    }
    if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use') {
      if (existing.status !== 'streaming') store.setStatus(threadId, 'streaming');
    }
    store.appendEvents(threadId, [event]);
    if (event.kind === 'done') {
      store.setStatus(threadId, 'idle');
    }
  }

  /** v1's `send()` returned a streamId + AsyncIterable. v2 returns the same
   *  shape for API compatibility, but the iterable is purely a lifecycle /
   *  cancellation channel — all store writes happen in `onEvent` above. */
  send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queue: ChatEvent[] = [];
    let resolveNext: ((v: IteratorResult<ChatEvent>) => void) | null = null;
    let closed = false;

    const close = () => {
      closed = true;
      resolveNext?.({ value: undefined as unknown as ChatEvent, done: true });
      resolveNext = null;
    };

    // Bridge the per-turn lifecycle through the existing store subscription.
    // We watch for a `done` event on this thread and close the iterable when
    // it lands. (The store-level subscription wrote the same event, so the
    // UI doesn't depend on this iterable at all.)
    let lifecycleUnlisten: UnlistenFn | null = null;
    const lifecyclePromise = sessionListen(input.threadId, (event) => {
      if (closed) return;
      const r = resolveNext;
      if (r) {
        resolveNext = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
      if (event.kind === 'done') {
        setTimeout(close, 0);
        lifecycleUnlisten?.();
      }
    });

    lifecyclePromise
      .then((u) => {
        if (closed) {
          u();
        } else {
          lifecycleUnlisten = u;
        }
      })
      .catch((err) => {
        useChatStore
          .getState()
          .setStatus(input.threadId, 'error', err instanceof Error ? err.message : String(err));
        close();
      });

    void (async () => {
      try {
        // Make sure the session row + main subscription exist.
        const cwd = useChatStore.getState().threads[input.threadId]?.thread.cwd ?? '';
        await this.attach(input.threadId, cwd || '/home/nedjamez/royalti-co');
        // Mark streaming up-front; onEvent will keep it set, and 'done' will clear it.
        useChatStore.getState().setStatus(input.threadId, 'streaming');
        await sessionSend(input.threadId, input.text);
      } catch (e) {
        useChatStore
          .getState()
          .setStatus(input.threadId, 'error', e instanceof Error ? e.message : String(e));
        close();
      }
    })();

    const iterable: AsyncIterable<ChatEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as ChatEvent, done: true });
            }
            return new Promise<IteratorResult<ChatEvent>>((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };

    return { streamId, iterable };
  }

  async cancel(_streamId: string): Promise<void> {
    // v2: streamId is opaque per-turn; cancellation is per-thread. The
    // composer's cancel button passes the active streamId, but we map it
    // back to the focused thread via the store.
    //
    // TODO(phase-10): when the composer switches to the ACP adapter (per
    // the acp-migration plan), route this through `acpCancel(threadId)`
    // instead of `sessionCancel`. The legacy `sessionCancel` Tauri
    // command kills the streaming child (`cancel_streaming`); `acpCancel`
    // writes a clean interrupt envelope so the transcript stays intact
    // and the child stays alive for the next turn. This adapter is the
    // legacy-cli path, so keeping `sessionCancel` here is correct for now.
    const state = useChatStore.getState();
    const active = Object.values(state.threads).find((t) => t.streamId === _streamId);
    const tid = active?.thread.id;
    if (!tid) return;
    try {
      await sessionCancel(tid);
    } catch (e) {
      console.warn('sessionCancel:', e);
    }
    state.appendEvents(tid, [
      { kind: 'system_hook', hookEvent: 'cancel', name: 'user_cancel' } as ChatEvent,
    ]);
    state.setStatus(tid, 'interrupted');
  }

  async suspend(): Promise<void> {
    // No-op for v1; we don't keep PTYs alive across navigations.
  }

  async migrate(_thread: ChatThread): Promise<void> {
    throw new Error('ClaudeCliAdapter.migrate: not implemented (no second adapter)');
  }

  async listSessions() {
    return claudeListSessions(null);
  }

  async destroy(): Promise<void> {
    const entries = [...this.streams.values()];
    this.streams.clear();
    for (const s of entries) {
      s.unlisten?.();
      try {
        await sessionDestroy(s.threadId);
      } catch (e) {
        console.warn('sessionDestroy:', e);
      }
    }
  }
}

export const ClaudeCliAdapter: ChatAdapter = new ClaudeCliAdapterImpl();

/** Test/maintenance helper. Exposed only on the concrete instance. */
export function getClaudeCliAdapterInstance(): ClaudeCliAdapterImpl {
  return ClaudeCliAdapter as unknown as ClaudeCliAdapterImpl;
}
