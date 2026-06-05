// Route → owning activity mode.
//
// The activity-bar mode (`useShellStore.activeMode`) and the focused pane's
// route are separate state. Clicking a rail icon sets the mode *and* navigates
// (see `activity-bar.tsx` MODE_LANDING); but a bare programmatic navigation —
// `/iyke/go`, a deep link — only moves the pane's route, leaving the mode
// (and therefore the rail highlight, sidebar, and workspace tint) stale.
//
// This maps a route back to the mode that *exclusively* owns it, so callers
// that navigate the focused pane can re-sync the mode. Only the three surfaces
// that were deliberately pulled out of App mode qualify:
//   • /packages*  — Packages mode (⌘5); "not a concern of App mode anymore"
//   • /claude*    — Ngwa mode (⌘6); replaced the old App-mode /claude nav item
//   • /settings*  — Settings mode (⌘,)
// Routes App mode *also* links to (/sessions, /artifacts, /, /todos, /cron …)
// are intentionally absent — they're ambiguous, so navigation to them must
// leave the current mode untouched rather than guess wrong.
//
// This is the inverse direction of `activity-bar.tsx`'s `MODE_LANDING`, kept
// here as a route *prefix* map (coarser than landing's exact paths). Keep the
// two in sync when a mode's route territory changes.
//
// Pkg routes (`/pkg/<id>/…`) resolve to that pkg's own activity mode
// (`pkg:<id>`) — each app pkg owns a mode, so navigating a pane to a pkg deep
// link re-syncs the rail highlight + sidebar to the pkg, the same as clicking
// its rail icon.

import { pkgIdFromRoute } from '@/lib/pkg/pkg-menu-store';
import type { ActivityMode } from './shell-store';

const EXCLUSIVE_MODE_PREFIXES: ReadonlyArray<readonly [string, ActivityMode]> = [
	['/packages', 'pkgs'],
	['/claude', 'ngwa'],
	['/settings', 'settings'],
];

/**
 * The activity mode that *exclusively* owns `path`, or `null` if the route is
 * shared across modes (the caller should keep the current mode). Matches on the
 * pathname only, so query strings (`/packages?filter=review`) and sub-paths
 * (`/settings/appearance`) resolve to the same owning mode, while a lookalike
 * sibling (`/packages-foo`) does not.
 */
export function modeForRoute(path: string): ActivityMode | null {
	const pathname = path.split(/[?#]/, 1)[0] ?? path;
	// A pkg route exclusively owns its own `pkg:<id>` mode.
	const pkgId = pkgIdFromRoute(pathname);
	if (pkgId) return `pkg:${pkgId}`;
	for (const [prefix, mode] of EXCLUSIVE_MODE_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return mode;
	}
	return null;
}
