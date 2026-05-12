/**
 * Chat module entry. Side-effect import registers all available adapters.
 *
 * Phase 10: both the legacy `ClaudeCliAdapter` ('cli') and the new
 * `AcpAdapter` ('acp') are registered at boot. The default adapter id used
 * by new chats is decided by `defaultChatAdapterId()` below, which reads
 * `localStorage.ikenga_chat_engine` (default `'acp'`). The legacy adapter
 * is retained for one release per the Phase 10 plan; Phase 11 retires it.
 */

import { registerAdapter, hasAdapter } from './registry';
import { ClaudeCliAdapter } from './adapters/claude-cli';
import { AcpAdapter } from './adapters/acp';

if (!hasAdapter('cli')) {
	registerAdapter(ClaudeCliAdapter);
	void ClaudeCliAdapter.init({});
}
if (!hasAdapter('acp')) {
	registerAdapter(AcpAdapter);
	void AcpAdapter.init({});
}

export { defaultChatAdapterId } from './default-adapter';
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
