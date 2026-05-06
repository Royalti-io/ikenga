import { createFileRoute, redirect } from '@tanstack/react-router';

// `/sessions/all` was the legacy "flat list" placeholder. The flat list now
// lives at `/sessions`; redirect so old links keep working.
export const Route = createFileRoute('/sessions/all/')({
  beforeLoad: () => {
    throw redirect({ to: '/sessions' });
  },
});
