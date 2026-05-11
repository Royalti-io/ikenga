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
  useThread,
  useEnsureThreadForSession,
  useChatActions,
  useThreadState,
  useChatColdStart,
  mintThreadId,
} from './hooks';
export { useChatStore } from './store';
export {
  findThreadByClaudeSessionId,
  findThreadById,
  createThread,
  appendUserTurn,
  loadUserTurns,
} from './persist';
export type { ChatThread, ChatAdapter, ChatInput } from './adapter';
