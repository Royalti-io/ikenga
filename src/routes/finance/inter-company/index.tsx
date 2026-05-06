import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';

import { matrixQuery, queueQuery } from '@/lib/queries/finance/reconciliation';
import { confirmPair, disputePair } from '@/lib/finance/inter-company';
import type { MatrixCell } from '@/lib/finance/inter-company';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import { fmtUsd } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

type TabKey = 'all' | 'unmatched' | 'suggested' | 'disputed' | 'matched';

const TABS: { value: TabKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'suggested', label: 'Suggested' },
  { value: 'unmatched', label: 'Unmatched' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'matched', label: 'Matched' },
];

function dirArrow(c: MatrixCell): string {
  if (c.direction === 'owed_to_from') return `${c.from_entity} → ${c.to_entity}`;
  if (c.direction === 'owed_to_to') return `${c.to_entity} → ${c.from_entity}`;
  return 'settled';
}

function InterCompanyPage() {
  const [tab, setTab] = useState<TabKey>('all');
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const matrix = useQuery(matrixQuery());
  const queue = useQuery(queueQuery(tab));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.finance.all });
  };

  const confirmMut = useMutation({
    mutationFn: (id: string) => confirmPair(supabase, id),
    onSuccess: invalidate,
  });
  const disputeMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      disputePair(supabase, id, reason),
    onSuccess: invalidate,
  });

  const cell = selectedCell
    ? matrix.data?.cells.find(
        (c) => `${c.from_entity}->${c.to_entity}` === selectedCell,
      )
    : null;

  return (
    <div className="px-6 py-4 space-y-6">
      {/* Balance matrix */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Balance Matrix</h2>
          <span className="text-xs text-muted-foreground">
            as of {matrix.data?.as_of ?? '…'} · USD-normalized
          </span>
        </div>
        {matrix.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading matrix…
          </div>
        )}
        {matrix.error instanceof Error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {matrix.error.message}
          </div>
        )}
        {matrix.data && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {matrix.data.cells.map((c) => {
              const key = `${c.from_entity}->${c.to_entity}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedCell(key)}
                  className={cn(
                    'cursor-pointer rounded-lg border border-border bg-card p-3 text-left transition hover:bg-accent/50',
                  )}
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {c.flow_tag || 'INTER-CO'}
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {c.from_entity} ↔ {c.to_entity}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {fmtUsd(c.net_balance_usd)}
                  </div>
                  <div className="text-xs text-muted-foreground">{dirArrow(c)}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.unmatched_count > 0 && (
                      <Badge
                        variant="outline"
                        className="border bg-amber-100 text-amber-800 border-amber-200 text-[10px] uppercase"
                      >
                        {c.unmatched_count} unmatched
                      </Badge>
                    )}
                    {c.disputed_count > 0 && (
                      <Badge
                        variant="outline"
                        className="border bg-red-100 text-red-800 border-red-200 text-[10px] uppercase"
                      >
                        {c.disputed_count} disputed
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Queue */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">Reconciliation Queue</h2>
          <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs',
                  tab === t.value
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {queue.data &&
                  ((t.value === 'unmatched' && queue.data.stats.unmatched > 0) ||
                    (t.value === 'suggested' && queue.data.stats.suggested > 0) ||
                    (t.value === 'disputed' && queue.data.stats.disputed > 0)) && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (
                      {t.value === 'unmatched'
                        ? queue.data.stats.unmatched
                        : t.value === 'suggested'
                          ? queue.data.stats.suggested
                          : queue.data.stats.disputed}
                      )
                    </span>
                  )}
              </button>
            ))}
          </div>
        </div>

        {queue.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading queue…
          </div>
        )}
        {queue.error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>{queue.error.message}</div>
          </div>
        )}
        {queue.data && queue.data.pairs.length === 0 && !queue.isLoading && (
          <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No pairs in this tab.
          </div>
        )}
        {queue.data && queue.data.pairs.length > 0 && (
          <div className="space-y-2">
            {queue.data.pairs.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'border text-[10px] uppercase',
                        p.status === 'matched' &&
                          'bg-emerald-100 text-emerald-800 border-emerald-200',
                        p.status === 'suggested' &&
                          'bg-blue-100 text-blue-800 border-blue-200',
                        p.status === 'unmatched' &&
                          'bg-amber-100 text-amber-800 border-amber-200',
                        p.status === 'disputed' &&
                          'bg-red-100 text-red-800 border-red-200',
                      )}
                    >
                      {p.status}
                    </Badge>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {p.flow_tag}
                    </span>
                    {p.match_score != null && (
                      <span className="text-xs text-muted-foreground">
                        score {Math.round(p.match_score * 100)}%
                      </span>
                    )}
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="font-medium">
                        {p.left.entity} · {fmtUsd(p.left.amount_usd)}
                      </div>
                      <div className="text-muted-foreground">
                        {p.left.date} — {p.left.memo}
                      </div>
                    </div>
                    {p.right ? (
                      <div>
                        <div className="font-medium">
                          {p.right.entity} · {fmtUsd(p.right.amount_usd)}
                        </div>
                        <div className="text-muted-foreground">
                          {p.right.date} — {p.right.memo}
                        </div>
                      </div>
                    ) : (
                      <div className="italic text-muted-foreground">(no partner)</div>
                    )}
                  </div>
                  {p.match_reason && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {p.match_reason}
                    </div>
                  )}
                </div>
                {p.status === 'suggested' && (
                  <div className="flex flex-shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={confirmMut.isPending}
                      onClick={() => confirmMut.mutate(p.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="h-3 w-3" /> Confirm
                    </button>
                    <button
                      type="button"
                      disabled={disputeMut.isPending}
                      onClick={() => {
                        const reason = window.prompt('Reason for dispute?') ?? '';
                        if (reason) disputeMut.mutate({ id: p.id, reason });
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-red-600 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                      <X className="h-3 w-3" /> Dispute
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Sheet open={!!cell} onOpenChange={(o) => !o && setSelectedCell(null)}>
        <SheetContent side="right" className="w-[24rem] max-w-[90vw] overflow-auto">
          {cell && (
            <>
              <SheetHeader>
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {cell.flow_tag || 'INTER-CO'}
                </div>
                <SheetTitle>
                  {cell.from_entity} ↔ {cell.to_entity}
                </SheetTitle>
                <SheetDescription>
                  Net balance · USD-normalized · as of {matrix.data?.as_of}
                </SheetDescription>
              </SheetHeader>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <dt className="text-xs text-muted-foreground">Net</dt>
                  <dd className="text-lg font-bold tabular-nums">
                    {fmtUsd(cell.net_balance_usd)}
                  </dd>
                </div>
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <dt className="text-xs text-muted-foreground">Direction</dt>
                  <dd className="text-sm">{dirArrow(cell)}</dd>
                </div>
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <dt className="text-xs text-muted-foreground">Entries</dt>
                  <dd className="text-sm">{cell.entry_count}</dd>
                </div>
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <dt className="text-xs text-muted-foreground">Unmatched</dt>
                  <dd className="text-sm">{cell.unmatched_count}</dd>
                </div>
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <dt className="text-xs text-muted-foreground">Disputed</dt>
                  <dd className="text-sm">{cell.disputed_count}</dd>
                </div>
              </dl>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export const Route = createFileRoute('/finance/inter-company/')({
  component: InterCompanyPage,
});
