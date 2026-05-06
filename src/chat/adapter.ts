/**
 * ChatAdapter interface — locked contract for any chat backend (CLI today,
 * SDK / Pencil deferred). Renderers (Thread / Composer / etc.) are completely
 * agnostic about which adapter is on the other end.
 *
 * v1 ships only `ClaudeCliAdapter`. Keep this file in sync with
 * `.company/technical/plans/2026-04-30-pa-desktop-migration/chat-adapters.md`.
 */

import type { ChatEvent } from '@/lib/tauri-cmd';

export type { ChatEvent };

export interface AdapterCapabilities {
  toolCalls: boolean;
  artifacts: boolean;
  fileAttachments: boolean;
  imageInput: boolean;
  slashCommands: boolean;
  modelSwitching: boolean;
  streaming: boolean;
  promptCaching: boolean;
  agenticTools: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface Attachment {
  kind: 'file' | 'image';
  path: string;
  name: string;
}

export interface ChatInput {
  threadId: string;
  text: string;
  attachments?: Attachment[];
  slashCommand?: { name: string; args: string };
}

/** Persisted thread metadata. The full event log is held in the store +
 *  mirrored to SQLite / Claude's on-disk JSONL. */
export interface ChatThread {
  id: string;
  adapterId: string;
  title: string | null;
  cwd: string;
  model: string | null;
  /** Set once we know the real Claude Code session id. */
  claudeSessionId: string | null;
  /** When the adapter currently has a live PTY for this thread. Cleared when
   *  the PTY exits or the app cold-starts. */
  ptyId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdapterContext {
  /** Reserved — adapters can use this hook to read settings / secrets. */
  getConfig?: () => Promise<unknown>;
}

export interface ChatAdapter {
  readonly id: string;
  readonly label: string;
  readonly Icon: React.ComponentType<{ className?: string }>;
  readonly models: ModelOption[] | null;
  readonly capabilities: AdapterCapabilities;

  init(ctx: AdapterContext): Promise<void>;
  /** Begin a turn. The store drains the iterable and updates UI state.
   *  Returns a `streamId` usable for `cancel()`. */
  send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> };
  cancel(streamId: string): Promise<void>;
  suspend(): Promise<void>;
  /** Only meaningful with multiple adapters; v1 is a no-op. */
  migrate(thread: ChatThread): Promise<void>;
  listSessions?(): Promise<unknown[]>;
  destroy(): Promise<void>;
}
