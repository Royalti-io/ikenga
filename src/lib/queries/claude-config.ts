import { useEffect } from 'react';
import { queryOptions, useQueryClient } from '@tanstack/react-query';

import {
	claudeConfigListen,
	claudeConfigLoad,
	claudeConfigUnwatch,
	claudeConfigWatch,
	type ClaudeConfig,
} from '@/lib/tauri-cmd';
import { queryKeys } from '@/lib/query-keys';

export type { ClaudeConfig };

export function claudeConfigQueryOptions(projectRoots: readonly string[]) {
	const roots = [...projectRoots];
	return queryOptions({
		queryKey: queryKeys.claudeConfig.load(roots),
		queryFn: () => claudeConfigLoad(roots),
		// The watcher invalidates on change; idle staleness is fine.
		staleTime: 60_000,
	});
}

/** Spin up a watcher for the supplied project roots and personal `~/.claude/`,
 *  invalidating the matching query on any FS change. Releases watchers and
 *  the listener on unmount.
 */
export function useClaudeConfigWatch(projectRoots: readonly string[], enabled = true) {
	const queryClient = useQueryClient();
	// Stable stringified key — re-attach when the root set changes.
	const key = [...projectRoots].sort().join('|');
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let unlisten: (() => void) | null = null;
		let watcherIds: string[] = [];
		const debounce = makeDebounce(150);
		void (async () => {
			try {
				const ids = await claudeConfigWatch([...projectRoots]);
				if (cancelled) {
					await claudeConfigUnwatch(ids);
					return;
				}
				watcherIds = ids;
				unlisten = await claudeConfigListen(ids, () => {
					debounce(() => {
						queryClient.invalidateQueries({ queryKey: queryKeys.claudeConfig.all });
					});
				});
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn('[claude-config] watch failed', e);
			}
		})();
		return () => {
			cancelled = true;
			if (unlisten) unlisten();
			if (watcherIds.length) {
				void claudeConfigUnwatch(watcherIds);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, enabled]);
}

function makeDebounce(ms: number) {
	let t: ReturnType<typeof setTimeout> | null = null;
	return (fn: () => void) => {
		if (t) clearTimeout(t);
		t = setTimeout(fn, ms);
	};
}
