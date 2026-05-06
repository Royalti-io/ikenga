import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/email' });
  },
});
