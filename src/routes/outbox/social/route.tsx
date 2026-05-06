import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import '../newsletter/newsletter.css';

interface InnerTab {
  to: string;
  label: string;
}

const TABS: InnerTab[] = [
  { to: '/outbox/social/queue', label: 'Approval queue' },
  { to: '/outbox/social/schedule', label: 'Schedule' },
  { to: '/outbox/social/sent', label: 'Sent' },
];

function useSocialCounts() {
  return useQuery({
    queryKey: ['outbox', 'social', 'counts'] as const,
    staleTime: 30_000,
    queryFn: async () => {
      const [queue, scheduled] = await Promise.all([
        supabase
          .from('social_queue')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'draft'),
        supabase
          .from('social_queue')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'approved'),
      ]);
      return { queue: queue.count ?? 0, scheduled: scheduled.count ?? 0 };
    },
  });
}

export const Route = createFileRoute('/outbox/social')({
  component: SocialLayout,
});

function SocialLayout() {
  const { location } = useRouterState();
  const path = location.pathname;
  const { data: counts } = useSocialCounts();

  return (
    <>
      <nav className="nl-inner-tabs" aria-label="Social sub-views">
        {TABS.map((tab) => {
          const isOn = path.startsWith(tab.to);
          const ct =
            tab.to === '/outbox/social/queue'
              ? counts?.queue
              : tab.to === '/outbox/social/schedule'
                ? counts?.scheduled
                : null;
          return (
            <Link key={tab.to} to={tab.to} className={isOn ? 'is-on' : ''}>
              {tab.label}
              {ct != null && <span className="ct">{ct}</span>}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </>
  );
}
