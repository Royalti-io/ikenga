import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Handshake, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

type PartnershipStage = 'research' | 'pitch' | 'negotiation' | 'active' | 'inactive';
type PartnershipPriority = 'hot' | 'warm' | 'cool';

interface PartnershipDeal {
  id: string;
  name: string;
  category: string | null;
  stage: PartnershipStage;
  priority: PartnershipPriority | null;
  owner_agent: string | null;
  total_score: number | null;
  contact_name: string | null;
  contact_email: string | null;
  revenue_year1_usd: number | null;
  health_score: number | null;
  next_action: string | null;
  next_action_date: string | null;
  days_in_stage: number;
  updated_at: string;
}

const STAGES: Array<{ value: PartnershipStage; label: string; color: string }> = [
  { value: 'research', label: 'Research', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  { value: 'pitch', label: 'Pitch', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'negotiation', label: 'Negotiation', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'active', label: 'Active', color: 'bg-green-100 text-green-800 border-green-200' },
];

const priorityColor: Record<PartnershipPriority, string> = {
  hot: 'bg-red-100 text-red-800 border-red-200',
  warm: 'bg-amber-100 text-amber-800 border-amber-200',
  cool: 'bg-blue-100 text-blue-800 border-blue-200',
};

function formatUsd(n: number | null): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function PartnershipsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['partnership_deals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('partnership_deals')
        .select('*')
        .neq('stage', 'inactive')
        .order('total_score', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as PartnershipDeal[];
    },
  });

  const deals = data ?? [];
  const totalDeals = deals.length;
  const pipelineValue = deals.reduce((sum, d) => sum + (d.revenue_year1_usd ?? 0), 0);
  const withHealth = deals.filter((d) => d.health_score != null);
  const avgHealth =
    withHealth.length > 0
      ? Math.round(withHealth.reduce((s, d) => s + (d.health_score ?? 0), 0) / withHealth.length)
      : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Handshake className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Partnerships</h1>
          {data && <span className="text-sm text-muted-foreground">({totalDeals})</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Strategic partnerships from research to active collaboration.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Active deals</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{totalDeals}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Y1 pipeline value</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{formatUsd(pipelineValue)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Avg health</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{avgHealth}</p>
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
              <p className="font-medium">Failed to load partnerships</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {STAGES.map((s) => {
              const items = deals.filter((d) => d.stage === s.value);
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
                      {items.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {items.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        Empty
                      </p>
                    ) : (
                      items.map((d) => (
                        <div
                          key={d.id}
                          className="rounded-md border border-border bg-background p-2 text-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium" title={d.name}>
                                {d.name}
                              </p>
                              {d.category && (
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {d.category}
                                </p>
                              )}
                            </div>
                            {d.priority && (
                              <Badge
                                variant="outline"
                                className={cn('border text-[10px]', priorityColor[d.priority])}
                              >
                                {d.priority}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>{formatUsd(d.revenue_year1_usd)}</span>
                            {d.total_score != null && <span>Score {d.total_score}</span>}
                            {d.health_score != null && <span>♥ {d.health_score}</span>}
                          </div>
                          {d.next_action && (
                            <p
                              className="mt-1 line-clamp-2 text-[10px] text-muted-foreground"
                              title={d.next_action}
                            >
                              → {d.next_action}
                            </p>
                          )}
                        </div>
                      ))
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

export const Route = createFileRoute('/partnerships/')({
  component: PartnershipsPage,
});
