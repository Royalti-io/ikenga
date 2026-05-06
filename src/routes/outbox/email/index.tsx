import { createFileRoute, redirect } from '@tanstack/react-router';

// /outbox/email is a layout-only route; redirect to /queue (the only
// view built today). Schedule + Sent are stubs.
export const Route = createFileRoute('/outbox/email/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/email/queue' });
  },
});
