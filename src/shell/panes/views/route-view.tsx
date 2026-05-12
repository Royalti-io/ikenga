import { useEffect, useMemo, createContext, useContext } from 'react';
import {
	RouterProvider,
	createRouter,
	createMemoryHistory,
	type AnyRouter,
} from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { queryClient } from '@/lib/query-client';
import { usePaneStore } from '@/lib/panes/pane-store';
import { getLeafIdsInOrder } from '@/lib/panes/pane-reducer';

// Each pane gets its own TanStack Router instance with memory history. We
// cache by paneId at module scope so the router (and its loader cache,
// match state, etc.) survives remounts when the surrounding PanelGroup
// rebuilds on structural changes (split/close).
const routerCache = new Map<string, AnyRouter>();

// Evict cache entries for panes that no longer exist. One global
// subscription is enough — pane changes are infrequent.
usePaneStore.subscribe((state) => {
	const liveIds = new Set(getLeafIdsInOrder(state.root));
	for (const id of Array.from(routerCache.keys())) {
		if (!liveIds.has(id)) routerCache.delete(id);
	}
});

function getOrCreateRouter(paneId: string, initialPath: string): AnyRouter {
	let router = routerCache.get(paneId);
	if (!router) {
		router = createRouter({
			routeTree,
			defaultPreload: 'intent',
			context: { queryClient },
			history: createMemoryHistory({ initialEntries: [initialPath || '/'] }),
		});
		routerCache.set(paneId, router);
	}
	return router;
}

// Context tag so __root can detect "I'm rendered inside a pane router" and
// skip the workspace shell (which would cause infinite recursion).
const PaneScopeContext = createContext<string | null>(null);

export function usePaneScope(): string | null {
	return useContext(PaneScopeContext);
}

interface RouteViewProps {
	paneId: string;
	path: string;
}

export function RouteView({ paneId, path }: RouteViewProps) {
	const router = useMemo(() => getOrCreateRouter(paneId, path), [paneId]);

	// Sync external path changes (sidebar nav, command palette) into this
	// pane's router. We compare to current location to avoid a redundant
	// navigate on first mount.
	useEffect(() => {
		if (router.state.location.pathname !== path) {
			void router.navigate({ to: path });
		}
	}, [path, router]);

	return (
		<PaneScopeContext.Provider value={paneId}>
			<RouterProvider router={router} />
		</PaneScopeContext.Provider>
	);
}
