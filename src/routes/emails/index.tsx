import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/emails/')({
  beforeLoad: () => {
    throw redirect({ to: '/mail/all' });
  },
});
