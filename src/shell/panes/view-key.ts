import type { PaneView } from '@/lib/panes/types';

/** Stable per-tab-instance identity, independent of both position AND
 *  content — unlike `viewKey` below (content-derived), this never collides
 *  for two tabs holding identical content (e.g. the same route opened
 *  twice in one pane). Backed by the reducer's object-identity WeakMap:
 *  reorder/close preserve the tab's object reference, so its id survives
 *  a move; same-slot content replacement (URL-bar nav, pin toggle) carries
 *  the id forward via `carryTabUid` in pane-reducer.ts. Used by pane.tsx's
 *  PaneBody key and route-view.tsx's per-tab router cache — both need
 *  "this exact tab", not "a tab shaped like this". */
export { tabUid } from '@/lib/panes/pane-reducer';

/** Stable, collision-free-*by-content* identity for a view — used as a React
 *  `key` where the caller only ever has one instance of a given
 *  session/target at a time (the dock's single active tab). Kind-prefixed so
 *  a terminal and a chat sharing the same id string never collide.
 *  terminal/chat ids are globally-unique uuids, so distinct sessions always
 *  get distinct keys. Does NOT distinguish two tabs with identical content
 *  in the same pane — use `tabUid` for that (pane.tsx, route-view.tsx).
 *
 *  Kept in its own React-import-free module so it stays cheaply unit-testable
 *  (pane-views.tsx pulls in the full view-component graph). */
export function viewKey(view: PaneView): string {
	switch (view.kind) {
		case 'route':
			return `route:${view.path}`;
		case 'terminal':
			return `terminal:${view.sessionId}`;
		case 'chat':
			return `chat:${view.sessionId}`;
		case 'artifact':
			return `artifact:${view.path}`;
		case 'artifact-studio':
			return `studio:${view.path}:${view.density}:${view.vs ?? ''}`;
		case 'scratchpad':
			return `scratch:${view.scope}:${view.name}`;
		case 'tool-output':
			return `tool:${view.threadId}:${view.toolUseId}`;
	}
}
