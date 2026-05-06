import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { newsletterDraftsListQuery } from '@/lib/queries/email-drafts';
import './newsletter.css';

interface InnerTab {
  to: string;
  label: string;
}

const TABS: InnerTab[] = [
  { to: '/outbox/newsletter/queue', label: 'Approval queue' },
  { to: '/outbox/newsletter/schedule', label: 'Schedule' },
  { to: '/outbox/newsletter/sent', label: 'Sent' },
];

export const Route = createFileRoute('/outbox/newsletter')({
  component: NewsletterLayout,
});

function NewsletterLayout() {
  const { location } = useRouterState();
  const path = location.pathname;
  const { data: drafts } = useQuery(
    newsletterDraftsListQuery({
      statuses: ['draft', 'pending_review', 'approved'],
    }),
  );

  const counts = {
    queue: (drafts ?? []).filter((d) =>
      ['draft', 'pending_review'].includes(d.status),
    ).length,
    schedule: (drafts ?? []).filter(
      (d) => d.scheduled_for && d.status !== 'sent',
    ).length,
  };

  return (
    <>
      <nav className="nl-inner-tabs" aria-label="Newsletter sub-views">
        {TABS.map((tab) => {
          const isOn = path.startsWith(tab.to);
          const ct =
            tab.to === '/outbox/newsletter/queue'
              ? counts.queue
              : tab.to === '/outbox/newsletter/schedule'
                ? counts.schedule
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
