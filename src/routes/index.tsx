// Default landing — redirects to /sessions (the canonical built-in surface
// post-strip). Earlier this route hosted a Royalti-specific dashboard with
// inbox/triage/tasks cards; that was gutted as part of the shell strip-down
// because every card linked to a route owned by an app pkg, not the shell
// itself. App pkgs are now responsible for their own landing pages.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/sessions' });
  },
});
