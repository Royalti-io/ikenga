/**
 * MockAdapter — kept for unit tests only. Not registered by default. Emits a
 * canned set of events when `send()` is called so the Thread/Composer can be
 * exercised without a real claude binary.
 */

import { Zap } from 'lucide-react';
import type { ChatEvent } from '@/lib/tauri-cmd';
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
  artifacts: false,
  fileAttachments: false,
  imageInput: false,
  slashCommands: false,
  modelSwitching: false,
  streaming: true,
  promptCaching: false,
  agenticTools: false,
};

const SCRIPT: ChatEvent[] = [
  { kind: 'session_init', sessionId: 'mock-1', model: 'mock', cwd: '/tmp', permissionMode: 'auto' },
  { kind: 'text', delta: 'Mock response.' },
  { kind: 'done', stopReason: 'end_turn', durationMs: 10 },
];

class MockAdapterImpl implements ChatAdapter {
  readonly id = 'mock';
  readonly label = 'Mock';
  readonly Icon = Zap;
  readonly models: ModelOption[] | null = null;
  readonly capabilities = CAPABILITIES;

  async init(_ctx: AdapterContext): Promise<void> {}

  send(_input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> } {
    const streamId = `mock-${Date.now()}`;
    const iterable: AsyncIterable<ChatEvent> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => {
            if (i >= SCRIPT.length) return { value: undefined as unknown as ChatEvent, done: true };
            return { value: SCRIPT[i++], done: false };
          },
        };
      },
    };
    return { streamId, iterable };
  }

  async cancel(_streamId: string): Promise<void> {}
  async suspend(): Promise<void> {}
  async migrate(_thread: ChatThread): Promise<void> {}
  async destroy(): Promise<void> {}
}

export const MockAdapter: ChatAdapter = new MockAdapterImpl();
