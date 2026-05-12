import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({
	beforeLoad: ({ location }) => {
		if (location.pathname === '/settings' || location.pathname === '/settings/') {
			throw redirect({ to: '/settings/appearance' });
		}
	},
	component: SettingsLayout,
});

function SettingsLayout() {
	// Sub-nav lives in the workspace sidebar (sidebar-modes/settings-mode.tsx)
	// when the rail's active mode is 'settings'. The route layout is just the
	// content surface.
	return (
		<div className="h-full overflow-auto">
			<Outlet />
		</div>
	);
}
