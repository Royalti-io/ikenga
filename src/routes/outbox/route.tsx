import { createFileRoute, Outlet } from '@tanstack/react-router';

/** `/outbox` parent layout — children (approvals, …) render through the Outlet. */
export const Route = createFileRoute('/outbox')({
	component: () => (
		<div className="h-full overflow-hidden">
			<Outlet />
		</div>
	),
});
