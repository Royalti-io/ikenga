/**
 * ClaudeCliAdapter — chat backend over Claude Code's streaming-input mode.
 *
 * Transport: ONE long-lived `claude --print --input-format stream-json
 * --output-format stream-json --verbose [--resume <id>]` child per thread,
 * connected via piped stdin/stdout (NOT a PTY — claude rejects stream-json
 * over a TTY). Anthropic-recommended pattern:
 * https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 *
 * Each `send()` call:
 *   1. If a streaming child is already alive for this thread, write the
 *      user-message envelope to its stdin via `claudeChatSend`.
 *   2. Otherwise spawn one with `claudeChatSpawn({ prompt, resumeSessionId })`
 *      — the prompt becomes the first stdin envelope inside the backend so
 *      the spawn is single-RPC.
 *   3. Subscribe to `claude://session/{placeholder}` and (once known)
 *      `claude://session/{realId}`, yielding events until `done` (which
 *      mirrors claude's `result` envelope, marking end-of-turn). The child
 *      stays alive — do NOT kill it on `done`.
 *
 * Lifecycle: the child is killed on `cancel()`, on app cold-start sweeps
 * (`clearLivePtys`), or when a follow-up call fails to find it (e.g. claude
 * crashed). On miss, the next `send` re-spawns with `--resume` to recover.
 */

import { Zap } from 'lucide-react';
import {
  claudeChatKill,
  claudeChatSend,
  claudeChatSpawn,
  claudeListSessions,
  claudeListenSession,
  type ChatEvent,
} from '@/lib/tauri-cmd';
import { useLiveSessions } from '@/lib/queries/live-sessions';
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

/** Lightweight async queue for turning event-listener callbacks into an
 *  AsyncIterable. Pushed events accumulate; consumers `await next()`. */
class EventQueue<T> {
  private items: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

interface InflightStream {
  streamId: string;
  threadId: string;
  /** Streaming child session id (placeholder, then real once known). */
  sessionId: string | null;
  unlistenPlaceholder: (() => void) | null;
  unlistenReal: (() => void) | null;
  queue: EventQueue<ChatEvent>;
}

class ClaudeCliAdapterImpl implements ChatAdapter {
  readonly id = 'cli';
  readonly label = 'Claude CLI';
  readonly Icon = Zap;
  readonly models: ModelOption[] | null = null;
  readonly capabilities = CAPABILITIES;

  private inflight = new Map<string, InflightStream>();

  async init(_ctx: AdapterContext): Promise<void> {
    // No API key needed — claude CLI authenticates itself.
  }

  send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queue = new EventQueue<ChatEvent>();
    const stream: InflightStream = {
      streamId,
      threadId: input.threadId,
      sessionId: null,
      unlistenPlaceholder: null,
      unlistenReal: null,
      queue,
    };
    this.inflight.set(streamId, stream);

    void this.runSend(input, stream).catch((err) => {
      queue.push({
        kind: 'parse_error',
        message: err instanceof Error ? err.message : String(err),
        line: '',
      });
      queue.close();
      this.cleanupStream(streamId);
    });

    return { streamId, iterable: queue };
  }

  private async runSend(input: ChatInput, stream: InflightStream): Promise<void> {
    const state = useChatStore.getState();
    const thread = state.threads[input.threadId]?.thread;
    if (!thread) throw new Error(`no thread state for ${input.threadId}`);

    // Existing streaming child for this thread? Reuse it.
    const liveChildId = thread.ptyId; // we re-use this column to track the streaming child sessionId
    let sessionId: string | null = null;

    if (liveChildId) {
      try {
        await claudeChatSend(liveChildId, input.text);
        sessionId = liveChildId;
      } catch (e) {
        // Child gone (crashed, killed, HMR, or app restart) — fall through to
        // spawn with --resume so the conversation continues. Expected after
        // dev hot-reloads; debug-level on purpose.
        console.debug('claudeChatSend recovery: spawning new child for', input.threadId, e);
        useChatStore.getState().setThread(input.threadId, { ptyId: null });
        useChatStore.getState().setLiveAttached(input.threadId, false);
      }
    }

    if (!sessionId) {
      const cwd = thread.cwd || '/home/nedjamez/royalti-co';
      const resumeId = thread.claudeSessionId ?? undefined;
      const spawn = await claudeChatSpawn(cwd, {
        prompt: input.text,
        resumeSessionId: resumeId,
      });
      sessionId = spawn.sessionId;
      useChatStore.getState().setThread(input.threadId, { ptyId: sessionId });
      useChatStore.getState().setLiveAttached(input.threadId, true);
      // Surface the live process to the sessions store so the existing UI
      // (Live badge, useEnsureThreadForSession's listener wiring) keeps
      // working. `kind: 'streaming'` tells the session detail page there's no
      // PTY to attach a Terminal tab to.
      useLiveSessions.getState().register({
        sessionId,
        ptyId: '',
        cwd,
        startedAt: Date.now(),
        kind: 'streaming',
      });
    }

    stream.sessionId = sessionId;
    let realId: string | null = thread.claudeSessionId ?? null;

    const onEvent = (e: ChatEvent) => {
      stream.queue.push(e);
      if (e.kind === 'session_init' && e.sessionId && e.sessionId !== realId) {
        realId = e.sessionId;
        useChatStore.getState().setThread(input.threadId, { claudeSessionId: e.sessionId });
        void updateThreadMeta(input.threadId, { claudeSessionId: e.sessionId });
        // Alias the live-session entry under the real id so route listeners
        // keyed on the real session id (e.g. after URL promotion) attach.
        if (sessionId) {
          useLiveSessions.getState().alias(sessionId, e.sessionId);
        }
        if (!stream.unlistenReal) {
          claudeListenSession(e.sessionId, onEvent)
            .then((u) => {
              if (this.inflight.has(stream.streamId)) stream.unlistenReal = u;
              else u();
            })
            .catch((err) => console.warn('listen real:', err));
        }
      }
      if (e.kind === 'done') {
        // End-of-turn: close the per-turn iterable but DO NOT kill the child.
        // The next send() will write to the same stdin.
        setTimeout(() => {
          stream.queue.close();
          this.cleanupStream(stream.streamId);
        }, 50);
      }
    };

    stream.unlistenPlaceholder = await claudeListenSession(sessionId, onEvent);
  }

  async cancel(streamId: string): Promise<void> {
    const stream = this.inflight.get(streamId);
    if (!stream) return;
    if (stream.sessionId) {
      try {
        await claudeChatKill(stream.sessionId);
      } catch (e) {
        console.warn('claudeChatKill cancel:', e);
      }
    }
    stream.queue.push({ kind: 'system_hook', hookEvent: 'cancel', name: 'user_cancel' });
    stream.queue.close();
    this.cleanupStream(streamId);
    const tid = stream.threadId;
    useChatStore.getState().setThread(tid, { ptyId: null });
    useChatStore.getState().setLiveAttached(tid, false);
    useChatStore.getState().setStatus(tid, 'interrupted');
  }

  private cleanupStream(streamId: string) {
    const s = this.inflight.get(streamId);
    if (!s) return;
    s.unlistenPlaceholder?.();
    s.unlistenReal?.();
    this.inflight.delete(streamId);
  }

  async suspend(): Promise<void> {
    // No-op for v1; we don't keep PTYs alive across navigations.
  }

  async migrate(_thread: ChatThread): Promise<void> {
    // Only one adapter exists in v1; never invoked. Throw loudly if called.
    throw new Error('ClaudeCliAdapter.migrate: not implemented (no second adapter in v1)');
  }

  async listSessions() {
    return claudeListSessions(null);
  }

  async destroy(): Promise<void> {
    for (const s of this.inflight.values()) {
      s.unlistenPlaceholder?.();
      s.unlistenReal?.();
      s.queue.close();
    }
    this.inflight.clear();
  }
}

export const ClaudeCliAdapter: ChatAdapter = new ClaudeCliAdapterImpl();
