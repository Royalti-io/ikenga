import type { PaneView } from '@/lib/panes/types';

/** Stable, collision-free identity for a view — used as a React `key` so each
 *  logical session/target gets its own component instance. Kind-prefixed so a
 *  terminal and a chat sharing the same id string never collide. terminal/chat
 *  ids are globally-unique uuids, so distinct sessions always get distinct
 *  keys (the load-bearing invariant the dock relies on to remount per tab).
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
