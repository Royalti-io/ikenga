import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2, RefreshCw, Search } from 'lucide-react';

import { receivablesQuery } from '@/lib/queries/finance/receivables';
import type { ReceivablesFilters } from '@/lib/finance/receivables';
import { fmtUsd } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const AGING_OPTIONS: { value: ReceivablesFilters['aging_bucket']; label: string }[] = [
  { value: '', label: 'All ages' },
  { value: 'current', label: 'Current (Not Due)' },
  { value: '1-30', label: '1-30 Days Overdue' },
  { value: '31-60', label: '31-60 Days Overdue' },
  { value: '60+', label: '60+ Days Overdue' },
];

function ReceivablesPage() {
  const [filters, setFilters] = useState<ReceivablesFilters>({
    page: 1,
    pageSize: 20,
  });
  const [searchInput, setSearchInput] = useState('');

  const { data, isLoading, error, refetch, isFetching } = useQuery(
    receivablesQuery(filters),
  );

  function update(patch: Partial<ReceivablesFilters>) {
    setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    update({ search: searchInput || undefined });
  }

  const hasActiveFilters = Boolean(
    filters.collection_status || filters.aging_bucket || filters.search,
  );

  function clearFilters() {
    setFilters({ page: 1, pageSize: filters.pageSize });
    setSearchInput('');
  }

  return (
    <div className="px-6 py-4 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Outstanding Receivables</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn('h-4 w-4 mr-2', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error instanceof Error && !isLoading && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-3" />
          <h3 className="text-base font-medium text-destructive">
            Failed to load receivables
          </h3>
          <p className="text-sm text-destructive/80 mt-1">{error.message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-4">
            Try Again
          </Button>
        </div>
      )}

      {isLoading && !data && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-3">Loading receivables…</span>
        </div>
      )}

      {data && !error && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Total Outstanding
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {fmtUsd(data.totals.totalOutstanding)}
              </p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 dark:border-red-900/50 dark:bg-red-950/30">
              <p className="text-xs uppercase tracking-wide text-red-700/80 dark:text-red-300/80">
                Total Overdue
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-red-700 dark:text-red-300">
                {fmtUsd(data.totals.totalOverdue)}
              </p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 dark:border-amber-900/50 dark:bg-amber-950/30">
              <p className="text-xs uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
                Overdue Invoices
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {data.totals.overdueCount}
              </p>
            </div>
          </div>

          {/* Aging buckets */}
          <div>
            <h3 className="mb-3 text-sm font-semibold">Aging Analysis</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.agingBuckets.map((b) => (
                <div
                  key={b.label}
                  className={cn(
                    'rounded-lg border p-4 transition-colors',
                    b.color,
                  )}
                >
                  <p className="text-xs font-medium opacity-80">{b.label}</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">
                    {fmtUsd(b.amount_usd)}
                  </p>
                  <p className="text-xs opacity-80">
                    {b.count} invoice{b.count === 1 ? '' : 's'} · {b.range}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="space-y-3">
            <form onSubmit={onSearchSubmit} className="flex max-w-md items-center gap-1">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search customer, invoice number, or description…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="w-full rounded-md border border-input bg-background pl-7 pr-2 py-1.5 text-xs"
                />
              </div>
              <Button type="submit" size="sm" variant="outline">
                Search
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filters.collection_status ?? ''}
                onChange={(e) => update({ collection_status: e.target.value || undefined })}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="">All collection statuses</option>
                {data.filterOptions.collectionStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <select
                value={filters.aging_bucket ?? ''}
                onChange={(e) =>
                  update({
                    aging_bucket: (e.target.value || '') as ReceivablesFilters['aging_bucket'],
                  })
                }
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {AGING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value ?? ''}>
                    {o.label}
                  </option>
                ))}
              </select>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          {/* Receivables table */}
          {data.receivables.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              No receivables match the current filters.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Invoice</th>
                    <th className="px-3 py-2 text-left font-medium">Customer</th>
                    <th className="px-3 py-2 text-left font-medium">Due</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Balance</th>
                    <th className="px-3 py-2 text-right font-medium">Days Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.receivables.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 align-top text-xs">
                        <div className="font-mono">{r.document_no ?? '—'}</div>
                        <div className="text-muted-foreground">{r.invoice_date}</div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{r.customer}</div>
                        {r.customer_email && (
                          <div className="text-xs text-muted-foreground">
                            {r.customer_email}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground tabular-nums">
                        {r.due_date ?? '—'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {r.collection_status && (
                          <Badge variant="outline" className="border text-[10px] uppercase">
                            {r.collection_status.replace(/_/g, ' ')}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">
                        <div className="font-semibold">{fmtUsd(r.balance_left_usd)}</div>
                        {r.currency !== 'USD' && (
                          <div className="text-xs text-muted-foreground">
                            {r.balance_left.toLocaleString()} {r.currency}
                          </div>
                        )}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 align-top text-right text-xs tabular-nums',
                          r.days_overdue <= 0
                            ? 'text-muted-foreground'
                            : r.days_overdue <= 30
                              ? 'text-amber-700'
                              : r.days_overdue <= 60
                                ? 'text-orange-700'
                                : 'text-red-700',
                        )}
                      >
                        {r.days_overdue <= 0 ? 'Current' : `${r.days_overdue}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Page {data.pagination.page} / {data.pagination.totalPages} ·{' '}
                {data.receivables.length} of {data.pagination.totalCount.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={filters.page <= 1}
                  onClick={() => update({ page: filters.page - 1 })}
                  className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={filters.page >= data.pagination.totalPages}
                  onClick={() => update({ page: filters.page + 1 })}
                  className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
                >
                  →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/finance/receivables/')({
  component: ReceivablesPage,
});
