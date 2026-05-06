import { create } from 'zustand';

/**
 * Tracks the placeholder sessionId → live ptyId mapping for sessions spawned
 * in the current app run. The detail route attaches its terminal/chat view
 * to a live PTY through this store; cleared when the PTY exits.
 *
 * On-disk replay (via `claudeReadJsonl`) doesn't need this — it works against
 * any stored session by id. This is purely for "I just spawned, give me the
 * live stream" lookup.
 */

export interface LiveSession {
  /** The id we route to — placeholder until the parser sees system:init,
   *  then both placeholder and real id resolve to the same entry. */
  sessionId: string;
  /** PTY id for `pty` sessions; empty string for `streaming` (which uses pipes
   *  and has no terminal to attach to). */
  ptyId: string;
  cwd: string;
  startedAt: number;
  /** `pty` = PTY-backed (one-shot, interactive resume) — has a terminal view.
   *  `streaming` = piped stdin/stdout (long-lived chat) — no terminal. */
  kind?: 'pty' | 'streaming';
}

interface LiveStore {
  sessions: Record<string, LiveSession>;
  /** Add or update an entry. Adds aliases under both ids when a real session
   *  id is discovered later so route lookups under the real id still work. */
  register(session: LiveSession): void;
  alias(placeholderId: string, realId: string): void;
  remove(sessionId: string): void;
  get(sessionId: string): LiveSession | undefined;
}

export const useLiveSessions = create<LiveStore>((set, get) => ({
  sessions: {},
  register: (session) =>
    set((state) => ({
      sessions: { ...state.sessions, [session.sessionId]: session },
    })),
  alias: (placeholderId, realId) =>
    set((state) => {
      const existing = state.sessions[placeholderId];
      if (!existing) return state;
      return {
        sessions: {
          ...state.sessions,
          [realId]: { ...existing, sessionId: realId },
        },
      };
    }),
  remove: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),
  get: (sessionId) => get().sessions[sessionId],
}));
