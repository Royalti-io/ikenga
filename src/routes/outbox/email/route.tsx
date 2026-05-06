import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import '../newsletter/newsletter.css';

interface InnerTab {
  to: string;
  label: string;
}

const TABS: InnerTab[] = [
  { to: '/outbox/email/queue', label: 'Approval queue' },
  { to: '/outbox/email/schedule', label: 'Schedule' },
  { to: '/outbox/email/sent', label: 'Sent' },
];

function useEmailCounts() {
  return useQuery({
    queryKey: ['outbox', 'email', 'counts'] as const,
    staleTime: 30_000,
    queryFn: async () => {
      const [queue, scheduled] = await Promise.all([
        supabase
          .from('email_drafts')
          .select('id', { count: 'exact', head: true })
          .in('status', ['draft', 'pending_review'])
          .neq('type', 'newsletter')
          .neq('type', 'investor_update'),
        supabase
          .from('email_drafts')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'approved')
          .neq('type', 'newsletter')
          .neq('type', 'investor_update'),
      ]);
      return { queue: queue.count ?? 0, scheduled: scheduled.count ?? 0 };
    },
  });
}

export const Route = createFileRoute('/outbox/email')({
  component: EmailLayout,
});

function EmailLayout() {
  const { location } = useRouterState();
  const path = location.pathname;
  const { data: counts } = useEmailCounts();

  return (
    <>
      <nav className="nl-inner-tabs" aria-label="Email sub-views">
        {TABS.map((tab) => {
          const isOn = path.startsWith(tab.to);
          const ct =
            tab.to === '/outbox/email/queue'
              ? counts?.queue
              : tab.to === '/outbox/email/schedule'
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
