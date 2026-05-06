import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Users, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

type SalesStage =
  | 'lead'
  | 'qualified'
  | 'demo'
  | 'trial'
  | 'negotiation'
  | 'closed-won'
  | 'closed-lost';

interface SalesDeal {
  id: string;
  company: string;
  contact_name: string | null;
  contact_email: string | null;
  stage: SalesStage;
  value: number;
  currency: string;
  score: number;
  last_contact: string | null;
  assigned_to: string | null;
  source: string | null;
  loss_reason: string | null;
  expected_close_date: string | null;
  days_in_stage: number;
  updated_at: string;
}

const STAGE_WEIGHTS: Record<SalesStage, number> = {
  lead: 0.05,
  qualified: 0.15,
  demo: 0.3,
  trial: 0.5,
  negotiation: 0.8,
  'closed-won': 1.0,
  'closed-lost': 0,
};

const STAGES: Array<{ value: SalesStage; label: string; color: string }> = [
  { value: 'lead', label: 'Lead', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  { value: 'qualified', label: 'Qualified', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'demo', label: 'Demo', color: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  { value: 'trial', label: 'Trial', color: 'bg-violet-100 text-violet-800 border-violet-200' },
  { value: 'negotiation', label: 'Negotiation', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'closed-won', label: 'Won', color: 'bg-green-100 text-green-800 border-green-200' },
];

function formatUsd(n: number): string {
  if (!n) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function SalesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sales_deals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales_deals')
        .select('*')
        .order('value', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as SalesDeal[];
    },
  });

  const deals = data ?? [];
  const open = deals.filter((d) => d.stage !== 'closed-won' && d.stage !== 'closed-lost');
  const totalPipeline = open.reduce((s, d) => s + (d.value ?? 0), 0);
  const weightedPipeline = open.reduce(
    (s, d) => s + (d.value ?? 0) * (STAGE_WEIGHTS[d.stage] ?? 0),
    0,
  );
  const won = deals.filter((d) => d.stage === 'closed-won');
  const wonValue = won.reduce((s, d) => s + (d.value ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Sales pipeline</h1>
          {data && <span className="text-sm text-muted-foreground">({open.length} open)</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Deal pipeline from sales_deals. (Twenty CRM sync via pa-actions runs separately.)
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Open deals</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{open.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Total pipeline</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{formatUsd(totalPipeline)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Weighted pipeline</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{formatUsd(weightedPipeline)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Won</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-green-600">
              {formatUsd(wonValue)}
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load sales deals</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {STAGES.map((s) => {
              const items = deals.filter((d) => d.stage === s.value);
              const stageValue = items.reduce((sum, d) => sum + (d.value ?? 0), 0);
              return (
                <div
                  key={s.value}
                  className="flex flex-col rounded-lg border border-border bg-card"
                >
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <Badge
                      variant="outline"
                      className={cn('border text-[10px] uppercase', s.color)}
                    >
                      {s.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {items.length} · {formatUsd(stageValue)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {items.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">Empty</p>
                    ) : (
                      items.slice(0, 8).map((d) => (
                        <div
                          key={d.id}
                          className="rounded-md border border-border bg-background p-2 text-xs"
                        >
                          <p className="truncate font-medium" title={d.company}>
                            {d.company}
                          </p>
                          {d.contact_name && (
                            <p className="truncate text-[10px] text-muted-foreground">
                              {d.contact_name}
                            </p>
                          )}
                          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {formatUsd(d.value)}
                            </span>
                            {d.score > 0 && <span>Score {d.score}</span>}
                            <span>{d.days_in_stage}d</span>
                          </div>
                        </div>
                      ))
                    )}
                    {items.length > 8 && (
                      <p className="px-2 text-center text-[10px] text-muted-foreground">
                        +{items.length - 8} more
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/sales/')({
  component: SalesPage,
});
