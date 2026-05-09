import { createFileRoute, redirect } from '@tanstack/react-router';

// `/settings` (exact) → `/settings/appearance`. The layout route at
// `route.tsx` also throws this redirect via `beforeLoad`, but we keep this
// file as an explicit safety net for TanStack's file-based routing.
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/appearance' });
  },
});
