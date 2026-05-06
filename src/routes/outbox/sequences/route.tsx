import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import '../newsletter/newsletter.css';

interface InnerTab {
  to: string;
  label: string;
}

// Sequences are special: cadence is per-recipient, so a calendar would lie.
// Tabs are Queue (drafts/awaiting approval) · Active (running) · Sent (completed).
const TABS: InnerTab[] = [
  { to: '/outbox/sequences/queue', label: 'Approval queue' },
  { to: '/outbox/sequences/active', label: 'Active' },
  { to: '/outbox/sequences/sent', label: 'Sent' },
];

function useSequenceCounts() {
  return useQuery({
    queryKey: ['outbox', 'sequences', 'counts'] as const,
    staleTime: 30_000,
    queryFn: async () => {
      const [queue, active] = await Promise.all([
        supabase
          .from('email_sequences')
          .select('id', { count: 'exact', head: true })
          .in('status', ['draft', 'review']),
        supabase
          .from('email_sequences')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
      ]);
      return { queue: queue.count ?? 0, active: active.count ?? 0 };
    },
  });
}

export const Route = createFileRoute('/outbox/sequences')({
  component: SequencesLayout,
});

function SequencesLayout() {
  const { location } = useRouterState();
  const path = location.pathname;
  const { data: counts } = useSequenceCounts();

  return (
    <>
      <nav className="nl-inner-tabs" aria-label="Sequence sub-views">
        {TABS.map((tab) => {
          const isOn = path.startsWith(tab.to);
          const ct =
            tab.to === '/outbox/sequences/queue'
              ? counts?.queue
              : tab.to === '/outbox/sequences/active'
                ? counts?.active
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
