import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { transactionDetailQuery } from '@/lib/queries/finance/transactions';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { fmtUsdSigned } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';

function TransactionDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(transactionDetailQuery(id));

  // Approximate USD using stored amount_usd if present, else show native.
  const amountUsd = data?.amount_usd ?? null;
  const signed =
    data && amountUsd != null
      ? data.type === 'expense'
        ? -Math.abs(amountUsd)
        : data.type === 'income'
          ? Math.abs(amountUsd)
          : amountUsd
      : null;

  const status = (data?.reconciliation_status ?? '').toLowerCase();
  const matchLabel =
    data?.linked_txn_id || status === 'matched' || status === 'cleared'
      ? 'paired'
      : status === 'disputed'
        ? 'disputed'
        : data?.category === 'inter_company'
          ? 'unmatched'
          : 'n/a';

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && navigate({ to: '/finance/transactions' })}
    >
      <SheetContent side="right" className="w-[36rem] max-w-[90vw] overflow-auto">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading transaction…
          </div>
        )}
        {error instanceof Error && (
          <div className="text-sm text-destructive">
            Failed to load transaction: {error.message}
          </div>
        )}
        {data && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">
                {data.description ?? data.counterparty ?? 'Transaction'}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
                <span>{data.entity}</span>
                <span>·</span>
                <span>{data.txn_date}</span>
                {matchLabel !== 'n/a' && (
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {matchLabel}
                  </Badge>
                )}
              </SheetDescription>
            </SheetHeader>

            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Amount">
                <span
                  className={cn(
                    'font-semibold tabular-nums',
                    signed != null && signed < 0
                      ? 'text-red-700'
                      : 'text-emerald-700',
                  )}
                >
                  {signed != null
                    ? fmtUsdSigned(signed)
                    : `${data.amount.toLocaleString()} ${data.currency}`}
                </span>
                {data.currency !== 'USD' && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({data.amount.toLocaleString()} {data.currency})
                  </span>
                )}
              </Row>
              <Row label="Type">{data.type ?? '—'}</Row>
              <Row label="Category">
                {data.category ?? '—'}
                {data.subcategory ? ` · ${data.subcategory}` : ''}
              </Row>
              <Row label="Counterparty">{data.counterparty ?? '—'}</Row>
              <Row label="Reconciliation">{data.reconciliation_status ?? '—'}</Row>
              {data.linked_txn_id && (
                <Row label="Paired with">
                  <code className="font-mono text-xs">{data.linked_txn_id}</code>
                </Row>
              )}
              <Row label="Source">{data.source_ref ?? '—'}</Row>
              <Row label="Imported at">
                {data.processed_at
                  ? new Date(data.processed_at).toLocaleString()
                  : '—'}
              </Row>
              {data.notes && (
                <Row label="Notes">
                  <span className="whitespace-pre-wrap">{data.notes}</span>
                </Row>
              )}
            </dl>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export const Route = createFileRoute('/finance/transactions/$id')({
  component: TransactionDetail,
});

