// Layout for `/pkg/$pkgId/...`. Renders `<Outlet />` so child routes
// (`./index.tsx` for the bare URL, `./$.tsx` for sub-paths) actually
// reach the user. Earlier this file owned the route resolution and the
// splat child never rendered because the parent component had no Outlet
// — every pkg URL collapsed into the parent's "not found" branch.
//
// Resolution moved to the index/splat children. The layout itself does
// nothing beyond delegating.

import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/pkg/$pkgId')({
	component: PkgRouteLayout,
});

function PkgRouteLayout() {
	return <Outlet />;
}
