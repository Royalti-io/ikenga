import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/triage/')({
  beforeLoad: () => {
    throw redirect({ to: '/pkg/com.ikenga.email/mail/triage' });
  },
});
