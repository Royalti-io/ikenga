import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/email-queue/approvals/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/email', search: { status: 'pending_review' } });
  },
});
