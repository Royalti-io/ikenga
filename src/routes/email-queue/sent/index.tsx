import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/email-queue/sent/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/sent', search: { type: 'email' } });
  },
});
