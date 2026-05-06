import { createFileRoute, redirect } from '@tanstack/react-router';

// /outbox/social is a layout-only route; redirect to /queue (the only
// view built today). Schedule + Sent are stubs.
export const Route = createFileRoute('/outbox/social/')({
  beforeLoad: () => {
    throw redirect({ to: '/outbox/social/queue' });
  },
});
