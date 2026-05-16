// Home route. The component lives in shell/home/home.tsx — kept separate so
// the canvas + widget bodies can be unit-tested in isolation. TanStack Router
// caches the component reference on its Route object at module load, so HMR
// swapping this file leaves the runtime router with the stale Route — we
// invalidate the HMR boundary to force a full reload on any change here.
//
// Design source: design/shell/concepts/03-screens/16-home.html and
// 16-home.artifact.html.

import { createFileRoute } from '@tanstack/react-router';
import { Home } from '@/shell/home/home';

function HomeRoute() {
	return <Home />;
}

export const Route = createFileRoute('/')({
	component: HomeRoute,
});

if (import.meta.hot) {
	import.meta.hot.invalidate();
}
