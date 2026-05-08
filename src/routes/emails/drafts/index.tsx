import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/emails/drafts/')({
  beforeLoad: () => {
    throw redirect({ to: '/pkg/com.ikenga.email/mail/drafts' });
  },
});
