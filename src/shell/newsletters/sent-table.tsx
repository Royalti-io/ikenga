import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  newsletterStatsQuery,
  type NewsletterStatsPoint,
} from '@/lib/queries/newsletters';

function pctBand(rate: number, kind: 'open' | 'click' | 'bounce' | 'complaint'): string {
  if (kind === 'open')
    return rate >= 0.3 ? 'ok' : rate >= 0.18 ? '' : 'warn';
  if (kind === 'click')
    return rate >= 0.05 ? 'ok' : rate >= 0.02 ? '' : 'warn';
  if (kind === 'bounce')
    return rate <= 0.01 ? 'ok' : rate <= 0.02 ? 'warn' : 'bad';
  return rate <= 0.0005 ? 'ok' : rate <= 0.001 ? 'warn' : 'bad';
}

function fmtPct(n: number, decimals = 1): string {
  return `${(n * 100).toFixed(decimals)}%`;
}

function EngagementBar({ row }: { row: NewsletterStatsPoint }) {
  // Visual breakdown: opened / clicked / bounce / complaint stacked.
  // Click is part of the open share, but for a quick visual we render them
  // adjacently rather than nested.
  const opened = row.openRate;
  const clicked = row.clickRate;
  const bounced = row.bounceRate;
  const complained = row.complaintRate;
  return (
    <div className="nl-eng-bar" title={`${fmtPct(opened)} opened · ${fmtPct(clicked)} clicked · ${fmtPct(bounced)} bounced`}>
      <div className="open" style={{ width: `${opened * 100}%` }} />
      <div className="click" style={{ width: `${clicked * 100}%` }} />
      <div className="bounce" style={{ width: `${bounced * 100}%` }} />
      <div className="complaint" style={{ width: `${complained * 100}%` }} />
    </div>
  );
}

interface Props {
  typeFilter: 'all' | 'newsletter' | 'investor_update';
  channelFilter: 'all' | 'listmonk' | 'resend' | 'smtp';
}

export function SentTable({ typeFilter, channelFilter }: Props) {
  const { data, isLoading, error } = useQuery(newsletterStatsQuery({ days: 365 }));

  const rows = useMemo(() => {
    const all = data ?? [];
    return all
      .filter((r) => {
        if (typeFilter !== 'all' && r.draftType !== typeFilter && r.draftType !== 'unknown')
          return false;
        if (channelFilter !== 'all' && r.deliverySystem !== channelFilter) return false;
        return true;
      })
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  }, [data, typeFilter, channelFilter]);

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--fg-muted)' }}>Loading…</div>
    );
  }
  if (error instanceof Error) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--danger)' }}>
        Failed to load sends: {error.message}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
        <h3>No sent newsletters</h3>
        <p>Editions appear here once <code>newsletter_sends</code> rows are written.</p>
      </div>
    );
  }

  return (
    <table className="nl-sent-table">
      <thead>
        <tr>
          <th>Edition</th>
          <th>Sent</th>
          <th className="num">Recipients</th>
          <th className="pct">Open</th>
          <th className="pct">Click</th>
          <th className="pct">Bounce</th>
          <th className="pct">Complaint</th>
          <th>Engagement</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <div style={{ fontWeight: 500 }}>{r.subject || r.edition || '—'}</div>
              <div className="meta">
                {r.deliverySystem}
                {r.edition ? ` · ${r.edition}` : ''}
                {r.campaignId ? ` · #${r.campaignId}` : ''}
              </div>
            </td>
            <td className="meta">
              {new Date(r.sentAt).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </td>
            <td className="num">{r.recipients.toLocaleString()}</td>
            <td className={`pct ${pctBand(r.openRate, 'open')}`}>{fmtPct(r.openRate)}</td>
            <td className={`pct ${pctBand(r.clickRate, 'click')}`}>{fmtPct(r.clickRate)}</td>
            <td className={`pct ${pctBand(r.bounceRate, 'bounce')}`}>
              {fmtPct(r.bounceRate, 2)}
            </td>
            <td className={`pct ${pctBand(r.complaintRate, 'complaint')}`}>
              {fmtPct(r.complaintRate, 2)}
            </td>
            <td style={{ minWidth: 120 }}>
              <EngagementBar row={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
