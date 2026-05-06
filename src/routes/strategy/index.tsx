import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Target, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

type InitiativeStatus = 'active' | 'queued' | 'completed' | 'paused' | 'cancelled';
type RiskSeverity = 'High' | 'Medium' | 'Low';
type RiskProbability = 'High' | 'Medium' | 'Low';
type RiskStatus = 'Active' | 'Pending' | 'Mitigated' | 'Materialized' | 'Closed';

interface StrategicInitiative {
  id: string;
  quarter: string;
  wip_slot: number | null;
  name: string;
  description: string | null;
  status: InitiativeStatus;
  owner_agent: string;
  ties_to_goal: boolean;
  uses_vehicle: boolean;
  addresses_bottleneck: boolean;
  rationale: string | null;
  deadline: string | null;
  progress_pct: number;
  budget_monthly_usd: number | null;
}

interface RiskRegisterEntry {
  id: string;
  category: string;
  title: string;
  severity: RiskSeverity;
  probability: RiskProbability;
  impact: string | null;
  mitigation_strategy: string | null;
  owner: string;
  status: RiskStatus;
  next_review: string | null;
}

const initiativeStatusColor: Record<InitiativeStatus, string> = {
  active: 'bg-green-100 text-green-800 border-green-200',
  queued: 'bg-blue-100 text-blue-800 border-blue-200',
  completed: 'bg-gray-100 text-gray-700 border-gray-200',
  paused: 'bg-amber-100 text-amber-800 border-amber-200',
  cancelled: 'bg-red-100 text-red-800 border-red-200',
};

const severityColor: Record<RiskSeverity, string> = {
  High: 'bg-red-100 text-red-800 border-red-200',
  Medium: 'bg-amber-100 text-amber-800 border-amber-200',
  Low: 'bg-blue-100 text-blue-800 border-blue-200',
};

function StrategyPage() {
  const initiativesQ = useQuery({
    queryKey: ['strategic_initiatives'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('strategic_initiatives')
        .select('*')
        .order('wip_slot', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as StrategicInitiative[];
    },
  });

  const risksQ = useQuery({
    queryKey: ['risk_register'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('risk_register')
        .select('*')
        .neq('status', 'Closed')
        .order('severity', { ascending: true });
      if (error) throw error;
      return (data ?? []) as RiskRegisterEntry[];
    },
  });

  const initiatives = initiativesQ.data ?? [];
  const active = initiatives.filter((i) => i.status === 'active');
  const queued = initiatives.filter((i) => i.status === 'queued');
  const wipSlots = active.filter((i) => i.wip_slot != null);
  const risks = risksQ.data ?? [];
  const highRisks = risks.filter((r) => r.severity === 'High');

  const isLoading = initiativesQ.isLoading || risksQ.isLoading;
  const firstError = initiativesQ.error || risksQ.error;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Strategy</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          WIP slots, initiatives, risk register. Validation log not yet wired (filesystem read).
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">WIP slots used</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{wipSlots.length}/3</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Active initiatives</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{active.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Queued</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{queued.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">High-severity risks</p>
            <p
              className={cn(
                'mt-1 text-2xl font-bold tabular-nums',
                highRisks.length > 0 ? 'text-red-600' : 'text-muted-foreground',
              )}
            >
              {highRisks.length}
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {firstError instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load strategy data</p>
              <p className="text-xs opacity-80">{firstError.message}</p>
            </div>
          </div>
        )}

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Initiatives
          </h2>
          {initiatives.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No strategic initiatives.
            </div>
          ) : (
            <div className="space-y-2">
              {initiatives.map((i) => (
                <div key={i.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {i.wip_slot != null && (
                          <Badge variant="outline" className="border bg-violet-100 text-violet-800 text-[10px] uppercase border-violet-200">
                            Slot {i.wip_slot}
                          </Badge>
                        )}
                        <h3 className="font-semibold">{i.name}</h3>
                        <Badge
                          variant="outline"
                          className={cn(
                            'border text-[10px] uppercase',
                            initiativeStatusColor[i.status],
                          )}
                        >
                          {i.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{i.quarter}</span>
                      </div>
                      {i.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{i.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Owner: {i.owner_agent}</span>
                        {i.deadline && (
                          <span>Deadline: {new Date(i.deadline).toLocaleDateString()}</span>
                        )}
                        {i.budget_monthly_usd != null && (
                          <span>${i.budget_monthly_usd}/mo</span>
                        )}
                        {i.ties_to_goal && <span className="text-green-700">↳ goal</span>}
                        {i.uses_vehicle && <span className="text-green-700">↳ vehicle</span>}
                        {i.addresses_bottleneck && (
                          <span className="text-green-700">↳ bottleneck</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-xs text-muted-foreground">progress</span>
                      <span className="text-lg font-bold tabular-nums">{i.progress_pct}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Risk register
          </h2>
          {risks.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No active risks.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Risk</th>
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-left font-medium">Severity</th>
                    <th className="px-3 py-2 text-left font-medium">Probability</th>
                    <th className="px-3 py-2 text-left font-medium">Owner</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {risks.map((r) => (
                    <tr key={r.id} className="border-t border-border hover:bg-accent/50">
                      <td className="px-3 py-2">
                        <p className="font-medium">{r.title}</p>
                        {r.mitigation_strategy && (
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                            mitigation: {r.mitigation_strategy}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{r.category}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={cn('border text-[10px] uppercase', severityColor[r.severity])}
                        >
                          {r.severity}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">{r.probability}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{r.owner}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/strategy/')({
  component: StrategyPage,
});
