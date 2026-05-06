import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/email-queue/sequences/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/sequences' });
  },
});
