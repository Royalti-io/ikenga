import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/email-queue/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/email' });
  },
});
