/**
 * Chat module entry. Side-effect import registers the default adapter.
 *
 * Add new adapters here when they exist; v1 only registers ClaudeCliAdapter.
 */

import { registerAdapter, hasAdapter } from './registry';
import { ClaudeCliAdapter } from './adapters/claude-cli';

if (!hasAdapter('cli')) {
  registerAdapter(ClaudeCliAdapter);
  void ClaudeCliAdapter.init({});
}

export { Thread } from './ui/thread';
export { Composer } from './ui/composer';
export { AdapterSwitcher } from './ui/adapter-switcher';
export {
  useEnsureThreadForSession,
  useChatActions,
  useThreadState,
  useChatColdStart,
} from './hooks';
export { useChatStore } from './store';
export type { ChatThread, ChatAdapter, ChatInput } from './adapter';
