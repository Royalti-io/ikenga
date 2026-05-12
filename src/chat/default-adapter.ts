/**
 * Phase 10 — chat adapter default resolution.
 *
 * Lives in its own file (vs. `index.ts`) so `hooks.ts` and adapter modules
 * can import it without forming a circular dependency through the public
 * chat barrel.
 *
 * Feature flag (`localStorage.ikenga_chat_engine`):
 *   - `'legacy'` or `'cli'` → use the legacy `ClaudeCliAdapter` ('cli')
 *   - anything else (default) → use the ACP-backed `AcpAdapter` ('acp')
 *
 * Existing threads keep whatever `adapterId` was persisted in SQLite when
 * they were created. This helper only governs new-thread defaults and any
 * call site that wants to mirror the user's preference (chat-view, sessions
 * route, etc.).
 */

export const CHAT_ENGINE_LOCAL_STORAGE_KEY = 'ikenga_chat_engine';

export type ChatAdapterId = 'acp' | 'cli';

export function defaultChatAdapterId(): ChatAdapterId {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const flag = localStorage.getItem(CHAT_ENGINE_LOCAL_STORAGE_KEY);
      if (flag === 'legacy' || flag === 'cli') return 'cli';
    }
  } catch {
    // SSR / restricted storage — fall through to default.
  }
  return 'acp';
}
