import { createFileRoute, redirect } from '@tanstack/react-router';

// /outbox/sequences is layout-only; redirect to /queue.
export const Route = createFileRoute('/outbox/sequences/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/sequences/queue' });
  },
});
