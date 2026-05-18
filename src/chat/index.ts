/**
 * Chat module entry. Side-effect import registers all available adapters.
 *
 * Phase 1 of the multi-engine rebuild registers `ClaudeCodeAdapter` under
 * the canonical id `'claude-code'`. The legacy `'cli'` and `'acp'` ids
 * remain registered as **aliases** to the same instance so existing
 * persisted `chat_threads.adapter` values keep resolving without a SQL
 * migration. New chats use `'claude-code'` (see `defaultChatAdapterId`).
 * Phase 2+ adds Gemini/Codex adapters here under their own ids.
 */

import { registerAdapter, hasAdapter } from './registry';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { GeminiAdapter } from './adapters/gemini';
import { CodexAdapter } from './adapters/codex';

if (!hasAdapter('claude-code')) {
	registerAdapter(ClaudeCodeAdapter);
	void ClaudeCodeAdapter.init({});
}
// Phase 2 of the multi-engine rebuild: Gemini lands as a sibling
// adapter. Same `ChatAdapter` contract; the Rust dispatcher in
// `commands/chat.rs` routes calls by `engineId` to `engines::gemini_acp`.
if (!hasAdapter('gemini')) {
	registerAdapter(GeminiAdapter);
	void GeminiAdapter.init({});
}
// Phase 3: Codex via PTY wrap. Coarse streaming-only adapter — no
// tool-use / permissions / model picker. Long-term upgrade path is
// `npx @zed-industries/codex-acp`; this stays the lowest-friction option.
if (!hasAdapter('codex')) {
	registerAdapter(CodexAdapter);
	void CodexAdapter.init({});
}
// Aliases for backward compat with persisted thread adapter ids.
if (!hasAdapter('acp')) registerAdapter({ ...ClaudeCodeAdapter, id: 'acp' });
if (!hasAdapter('cli')) registerAdapter({ ...ClaudeCodeAdapter, id: 'cli' });

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
export { useChatStore, selectTotalCostUsd, findToolPairById } from './store';
export type { PairedToolCall } from './store';
export {
	findThreadByClaudeSessionId,
	findThreadById,
	createThread,
	appendUserTurn,
	loadUserTurns,
} from './persist';
export type { ChatThread, ChatAdapter, ChatInput } from './adapter';
