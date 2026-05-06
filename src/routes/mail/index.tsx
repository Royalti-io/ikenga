import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/mail/')({
  beforeLoad: () => {
    throw redirect({ to: '/mail/inbox' });
  },
});
