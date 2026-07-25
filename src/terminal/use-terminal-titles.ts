/**
 * use-terminal-titles — the React half of `terminal-title.ts`.
 *
 * Joins two sources per terminal:
 *   - the session store (`TerminalTab`): spawn cwd, argv, title, status. Always
 *     present, even before the PTY exists.
 *   - the Rust core (`pty_terminal_list`): the LIVE foreground command and any
 *     agent-assigned label. Polled, because neither pushes an event today.
 *
 * One query key backs every consumer (tab strips, dock, detached pop-out), so
 * TanStack dedupes them into a single poll no matter how many terminals or
 * panes are on screen — and it doesn't run at all when there are no terminals.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { getHomeSync } from '@/lib/home';
import { ptyTerminalList, type TerminalDescriptor } from '@/lib/tauri-cmd';
import { useTerminalStore } from '@/terminal/session-store';
import { formatTerminalTitle, type TerminalTitle } from '@/terminal/terminal-title';

export const TERMINAL_LIST_QUERY_KEY = ['pty-terminal-list'] as const;

/** How often the live foreground command is re-read. The Rust lookup is cached
 *  1s per PTY, so this is the real cost; 4s keeps a `claude` launch visible in
 *  the tab within a beat without polling hard. */
const REFETCH_MS = 4_000;

/** Live descriptors, keyed twice — by session-store tab id (when the spawn
 *  declared one) and by pty id (the fallback join, and the only key a detached
 *  window has). */
export interface TerminalDescriptorIndex {
	byTerminalId: Map<string, TerminalDescriptor>;
	byPtyId: Map<string, TerminalDescriptor>;
}

function indexDescriptors(list: TerminalDescriptor[] | undefined): TerminalDescriptorIndex {
	const byTerminalId = new Map<string, TerminalDescriptor>();
	const byPtyId = new Map<string, TerminalDescriptor>();
	for (const d of list ?? []) {
		if (d.terminal_id) byTerminalId.set(d.terminal_id, d);
		byPtyId.set(d.pty_id, d);
	}
	return { byTerminalId, byPtyId };
}

/** Raw descriptor index. `enabled` lets a caller that knows it has no terminals
 *  (the common case for a fresh window) skip the poll entirely. */
export function useTerminalDescriptors(enabled = true): TerminalDescriptorIndex {
	const query = useQuery({
		queryKey: TERMINAL_LIST_QUERY_KEY,
		queryFn: () => ptyTerminalList(),
		// Stop polling once the command fails rather than retrying every few
		// seconds forever. The one way this errors in practice is a frontend
		// hot-reloaded against a Rust binary that predates `pty_terminal_list`;
		// titles then fall back to their spawn-time form (still a real name,
		// just not live-tracked) instead of filling the console.
		refetchInterval: (q) => (q.state.error ? false : REFETCH_MS),
		retry: 1,
		enabled,
	});
	return useMemo(() => indexDescriptors(query.data), [query.data]);
}

export type TerminalTitleResolver = (sessionId: string) => TerminalTitle | null;

/**
 * Returns a resolver mapping a terminal session id (`TerminalTab.id`, which is
 * what a `{ kind: 'terminal' }` PaneView carries) to its display title.
 *
 * Returns null for an unknown id so callers can fall back — a tab whose session
 * was closed out from under it still renders something.
 */
export function useTerminalTitles(): TerminalTitleResolver {
	const tabs = useTerminalStore((s) => s.tabs);
	const descriptors = useTerminalDescriptors(tabs.length > 0);

	const titles = useMemo(() => {
		const home = getHomeSync();
		const map = new Map<string, TerminalTitle>();
		for (const tab of tabs) {
			const d =
				descriptors.byTerminalId.get(tab.id) ??
				(tab.ptyId ? descriptors.byPtyId.get(tab.ptyId) : undefined);
			map.set(
				tab.id,
				formatTerminalTitle({
					cwd: tab.spec.cwd,
					argv: tab.spec.cmd,
					title: tab.title,
					foreground: d?.foreground_command?.name ?? null,
					agentLabel: d?.label ?? null,
					exited: tab.status === 'exited',
					home,
				})
			);
		}
		return map;
	}, [tabs, descriptors]);

	return useCallback((sessionId: string) => titles.get(sessionId) ?? null, [titles]);
}

/**
 * Title for a terminal identified only by its PTY id — the detached pop-out
 * case, where the window is handed `terminal:<ptyId>` and has no session-store
 * entry to join against (the store lives in the origin window).
 */
export function useTerminalTitleByPtyId(ptyId: string | null): TerminalTitle | null {
	const descriptors = useTerminalDescriptors(Boolean(ptyId));
	return useMemo(() => {
		if (!ptyId) return null;
		const d = descriptors.byPtyId.get(ptyId);
		if (!d) return null;
		return formatTerminalTitle({
			cwd: d.cwd,
			argv: d.argv,
			title: d.title,
			foreground: d.foreground_command?.name ?? null,
			agentLabel: d.label,
			exited: d.status === 'exited',
			home: getHomeSync(),
		});
	}, [ptyId, descriptors]);
}
