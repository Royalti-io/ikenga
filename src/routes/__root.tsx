import { Outlet, createRootRoute } from '@tanstack/react-router';

import { Workspace } from '@/shell/workspace';
import { AuthModal } from '@/shell/auth-modal';
import { useSession } from '@/lib/auth';
import { usePaneScope } from '@/shell/panes/views/route-view';

function RootRoute() {
  // When this same root component renders inside a pane's memory router,
  // `usePaneScope` returns the pane id. We must only emit <Outlet /> in
  // that case — rendering Workspace again would recursively mount the
  // entire shell inside every route pane.
  const paneScope = usePaneScope();
  if (paneScope !== null) {
    return <Outlet />;
  }

  const { isAuthed, loading } = useSession();

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading session…
      </div>
    );
  }

  if (!isAuthed) {
    return <AuthModal />;
  }

  return <Workspace />;
}

export const Route = createRootRoute({
  component: RootRoute,
});
