import { useMemo, useState } from 'react';
import { createFileRoute, useNavigate, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2, Search } from 'lucide-react';

import { transactionsQuery } from '@/lib/queries/finance/transactions';
import type { TxnFilters } from '@/lib/finance/transactions';
import { useEntityStore } from '@/lib/finance/entity-store';
import { fmtUsdSigned } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

const MATCH_OPTIONS: { value: TxnFilters['match']; label: string }[] = [
  { value: '', label: 'Any match' },
  { value: 'paired', label: 'Paired' },
  { value: 'unmatched', label: 'Unmatched' },
  { value: 'disputed', label: 'Disputed' },
];

const CURRENCY_OPTIONS: { value: TxnFilters['currency']; label: string }[] = [
  { value: '', label: 'Any currency' },
  { value: 'USD', label: 'USD' },
  { value: 'NGN', label: 'NGN' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
];

function matchBadgeColor(s: string) {
  switch (s) {
    case 'paired':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'unmatched':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'disputed':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function TransactionsPage() {
  const navigate = useNavigate();
  const entity = useEntityStore((s) => s.entity);
  const [localFilters, setLocalFilters] = useState<Omit<TxnFilters, 'entity'>>({
    page: 1,
    per_page: 100,
  });
  const [searchInput, setSearchInput] = useState('');

  const filters: TxnFilters = useMemo(
    () => ({ ...localFilters, entity }),
    [localFilters, entity],
  );

  const { data, isLoading, error } = useQuery(transactionsQuery(filters));

  const total = data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / filters.per_page));

  function update(patch: Partial<Omit<TxnFilters, 'entity'>>) {
    setLocalFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    update({ search: searchInput || undefined });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <form onSubmit={onSearchSubmit} className="flex items-center gap-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search description / counterparty"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-64 rounded-md border border-input bg-background pl-7 pr-2 py-1 text-xs"
            />
          </div>
        </form>
        <input
          type="date"
          value={filters.date_from ?? ''}
          onChange={(e) => update({ date_from: e.target.value || undefined })}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <input
          type="date"
          value={filters.date_to ?? ''}
          onChange={(e) => update({ date_to: e.target.value || undefined })}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
        <select
          value={filters.match ?? ''}
          onChange={(e) => update({ match: (e.target.value || '') as TxnFilters['match'] })}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          {MATCH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={filters.currency ?? ''}
          onChange={(e) =>
            update({ currency: (e.target.value || '') as TxnFilters['currency'] })
          }
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          {CURRENCY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
        {data && (
          <span className="ml-auto text-xs text-muted-foreground">
            {total.toLocaleString()} transactions
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 border-b border-border px-6 py-3">
        <SummaryCard label="Inflow" value={data ? fmtUsdSigned(data.summary.inflow_usd) : '—'} />
        <SummaryCard label="Outflow" value={data ? fmtUsdSigned(data.summary.outflow_usd) : '—'} />
        <SummaryCard label="Net" value={data ? fmtUsdSigned(data.summary.net_usd) : '—'} />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load transactions</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && data.transactions.length === 0 && !isLoading && (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No transactions match.
          </div>
        )}

        {data && data.transactions.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Entity</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-left font-medium">Match</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() =>
                      navigate({ to: '/finance/transactions/$id', params: { id: t.id } })
                    }
                    className="cursor-pointer border-t border-border hover:bg-accent/50"
                  >
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground tabular-nums">
                      {t.date}
                    </td>
                    <td className="px-3 py-2 align-top text-xs">{t.entity}</td>
                    <td className="px-3 py-2 align-top">
                      <div className="max-w-[28rem] truncate" title={t.description}>
                        {t.description}
                      </div>
                      {t.account?.label && (
                        <div className="text-xs text-muted-foreground">
                          {t.account.label}
                          {t.account.last4 ? ` · …${t.account.last4}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                      {t.category ?? '—'}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {t.match_status !== 'n/a' && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'border text-[10px] uppercase',
                            matchBadgeColor(t.match_status),
                          )}
                        >
                          {t.match_status}
                        </Badge>
                      )}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 align-top text-right tabular-nums',
                        t.amount_usd < 0 ? 'text-red-700' : 'text-emerald-700',
                      )}
                    >
                      {fmtUsdSigned(t.amount_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && total > filters.per_page && (
          <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
            <span>
              Page {filters.page} / {pages} · {data.transactions.length} of{' '}
              {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={filters.page <= 1}
                onClick={() =>
                  setLocalFilters((f) => ({ ...f, page: f.page - 1 }))
                }
                className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
              >
                ←
              </button>
              <button
                type="button"
                disabled={filters.page * filters.per_page >= total}
                onClick={() =>
                  setLocalFilters((f) => ({ ...f, page: f.page + 1 }))
                }
                className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
              >
                →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail sheet child route */}
      <Outlet />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export const Route = createFileRoute('/finance/transactions')({
  component: TransactionsPage,
});
