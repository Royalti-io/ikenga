import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { SentCharts } from '@/shell/newsletters/sent-charts';
import { SentTable } from '@/shell/newsletters/sent-table';

interface SentSearch {
  view?: 'table' | 'charts';
}

const VIEW_KEY = 'newsletter.sent.view';

export const Route = createFileRoute('/outbox/newsletter/sent/')({
  validateSearch: (search: Record<string, unknown>): SentSearch => ({
    view:
      search.view === 'table' || search.view === 'charts'
        ? search.view
        : undefined,
  }),
  component: NewsletterSentPage,
});

function NewsletterSentPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [typeFilter, setTypeFilter] =
    useState<'all' | 'newsletter' | 'investor_update'>('all');
  const [channelFilter, setChannelFilter] =
    useState<'all' | 'listmonk' | 'resend' | 'smtp'>('all');

  // Resolve view from URL → localStorage → default 'charts'.
  const view: 'table' | 'charts' =
    search.view ??
    (typeof window !== 'undefined'
      ? ((window.localStorage.getItem(VIEW_KEY) as 'table' | 'charts' | null) ?? 'charts')
      : 'charts');

  // Persist view changes to localStorage.
  useEffect(() => {
    if (search.view) {
      try {
        window.localStorage.setItem(VIEW_KEY, search.view);
      } catch {
        // ignore
      }
    }
  }, [search.view]);

  function setView(next: 'table' | 'charts') {
    navigate({
      to: '/outbox/newsletter/sent',
      search: { view: next },
      replace: true,
    });
  }

  return (
    <>
      <div className="nl-sent-toolbar">
        {(['all', 'newsletter', 'investor_update'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`ob-filter-chip${typeFilter === t ? ' is-on' : ''}`}
            onClick={() => setTypeFilter(t)}
          >
            {t === 'all' ? 'All types' : t === 'newsletter' ? 'Newsletter' : 'Investor update'}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-soft)', margin: '0 4px' }} />
        {(['all', 'listmonk', 'resend', 'smtp'] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`ob-filter-chip${channelFilter === c ? ' is-on' : ''}`}
            onClick={() => setChannelFilter(c)}
          >
            {c === 'all' ? 'All channels' : c}
          </button>
        ))}
        <div className="nl-view-toggle">
          <button
            type="button"
            className={view === 'table' ? 'is-on' : ''}
            onClick={() => setView('table')}
          >
            Table
          </button>
          <button
            type="button"
            className={view === 'charts' ? 'is-on' : ''}
            onClick={() => setView('charts')}
          >
            Charts
          </button>
        </div>
      </div>
      {view === 'table' ? (
        <SentTable typeFilter={typeFilter} channelFilter={channelFilter} />
      ) : (
        <SentCharts typeFilter={typeFilter} channelFilter={channelFilter} />
      )}
    </>
  );
}
