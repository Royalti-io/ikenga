import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { crmLookupQuery, type CrmLookupResult } from '@/lib/queries/crm-lookup';

interface Props {
  email: string | null;
}

// 8-cell reply intelligence panel (screen 12 §C). Rendered above the body
// so a reviewer can decide in seconds. Cells fall back to em-dash ("—")
// when the underlying data isn't available; the panel collapses to the
// "Unknown sender" empty state (§H) when neither Twenty CRM nor email_drafts
// has any history with this address.
export function ReplyIntelligence({ email }: Props) {
  const { data, isLoading } = useQuery(crmLookupQuery(email));

  if (!email) return null;

  if (isLoading) {
    return (
      <div className="ri-panel">
        <div className="ri-panel-head">
          <span>Reply intelligence</span>
          <span className="ob-chip" style={{ marginLeft: 'auto' }}>
            <Loader2 className="animate-spin" aria-hidden style={{ width: 10, height: 10 }} />
            Loading
          </span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="ri-panel">
        <div className="ri-panel-head">
          <span>Reply intelligence</span>
        </div>
        <div className="ri-empty">
          <span className="ob-chip">no crm record</span>
          <span className="who">{email} · first contact in this thread</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ri-panel">
      <div className="ri-panel-head">
        <span>Reply intelligence</span>
        <span className="ob-chip ob-chip-tint" style={{ marginLeft: 'auto' }}>
          {data.in_crm ? 'CRM · Twenty' : 'partial · email history only'}
        </span>
      </div>
      <div className="ri-grid">
        <Cell
          label="Tenant"
          value={data.tenant?.name ?? '—'}
          sub={data.tenant?.sub ?? (data.tenant ? null : 'no CRM record')}
        />
        <Cell
          label="Last touch"
          value={
            data.last_touch
              ? `${shortDate(data.last_touch.at)} · ${truncate(data.last_touch.subject, 24)}`
              : '—'
          }
          sub={data.last_touch ? data.last_touch.direction === 'out' ? 'we sent' : 'they wrote' : 'no prior touch'}
        />
        <Cell
          label="Health"
          value={data.health?.label ?? '—'}
          sub={data.health?.sub ?? 'requires Royalti DB'}
          tone={data.health?.tone}
        />
        <Cell
          label="Sequence"
          value={
            data.sequence
              ? `${data.sequence.name}`
              : '— none —'
          }
          sub={
            data.sequence
              ? `step ${data.sequence.step ?? '?'} of ${data.sequence.total ?? '?'}`
              : 'manual reply · not part of a run'
          }
        />
        <Cell
          label="Catalog"
          value={
            data.catalog
              ? `${data.catalog.products} products · ${data.catalog.tracks} tracks`
              : '—'
          }
          sub={data.catalog?.sub ?? 'requires Royalti DB'}
        />
        <Cell
          label="Open balance"
          value={
            data.open_balance ? `$${data.open_balance.amount_usd.toLocaleString()}` : '—'
          }
          sub={data.open_balance?.sub ?? 'requires Royalti DB'}
        />
        <Cell label="Owner" value={data.owner?.name ?? '—'} sub={data.owner?.sub} />
        <Cell
          label="Risk flag"
          value={data.risk_flag?.label ?? '—'}
          sub={data.risk_flag?.sub ?? 'support tickets table not wired'}
          tone={data.risk_flag?.tone}
        />
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className="ri-cell">
      <div className="ri-cell-label">{label}</div>
      <div className={`ri-cell-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {sub && <div className="ri-cell-sub">{sub}</div>}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// Re-export the CRM result type for callers that need it (e.g. handoff seed).
export type { CrmLookupResult };
