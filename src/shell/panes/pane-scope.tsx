import { createContext, useContext } from 'react';

// Context tag so a route rendered inside a pane's memory router can detect
// "I'm rendered inside a pane router" (and recover the owning pane id) rather
// than re-mounting the whole workspace shell (__root) or losing the pane id.
//
// Kept in its own React-only module (no route-tree / router imports) so it can
// be consumed from components that also live upstream of the route tree —
// notably `pkg-iframe-host.tsx`, which the route tree imports. Importing it
// from `route-view.tsx` (which pulls `routeTree.gen`) would form an import
// cycle: pkg-iframe-host → route-view → routeTree → pkg route → pkg-iframe-host.
const PaneScopeContext = createContext<string | null>(null);

export const PaneScopeProvider = PaneScopeContext.Provider;

/** The id of the pane whose memory-router is currently rendering this subtree,
 *  or `null` at the top-level shell render (main window, outside any pane). */
export function usePaneScope(): string | null {
	return useContext(PaneScopeContext);
}
