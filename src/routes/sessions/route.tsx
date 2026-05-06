import { Link, Outlet, createFileRoute, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { sessionsListQueryOptions } from '@/lib/queries/sessions';
import { cn } from '@/components/ui/utils';

import './sessions.css';

export const Route = createFileRoute('/sessions')({
  component: SessionsLayout,
});

function SessionsLayout() {
  const loc = useLocation();
  const { data } = useQuery(sessionsListQueryOptions(null));
  const total = data?.length ?? 0;

  const isAll = loc.pathname === '/sessions' || loc.pathname === '/sessions/';
  const isAgents = loc.pathname.startsWith('/sessions/by-agent');

  return (
    <div className="flex h-full flex-col">
      <div className="ses-section-tabs">
        <Link
          to="/sessions/by-agent"
          className={cn('ses-section-tab', isAgents && 'is-on')}
        >
          Agents
        </Link>
        <Link
          to="/sessions"
          className={cn('ses-section-tab', isAll && 'is-on')}
        >
          All sessions
          {total > 0 && <span className="ct">{total}</span>}
        </Link>
      </div>
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
