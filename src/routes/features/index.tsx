import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Lightbulb, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

type FeatureStatus = 'idea' | 'planned' | 'in_progress' | 'shipped';

interface ProductFeature {
  id: string;
  name: string;
  description: string | null;
  status: FeatureStatus;
  source: string | null;
  requested_by: string | null;
  rice_score: number | null;
  rice_reach: number | null;
  rice_impact: number | null;
  rice_confidence: number | null;
  rice_effort: number | null;
  progress_pct: number;
  target_quarter: string | null;
  shipped_date: string | null;
  strategic_theme: string | null;
  created_at: string;
}

const STATUSES: Array<{ value: FeatureStatus; label: string; color: string }> = [
  { value: 'idea', label: 'Idea', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  { value: 'planned', label: 'Planned', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'shipped', label: 'Shipped', color: 'bg-green-100 text-green-800 border-green-200' },
];

function FeaturesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['product_features'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('product_features')
        .select('*')
        .order('rice_score', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ProductFeature[];
    },
  });

  const features = data ?? [];
  const totalFeatures = features.length;
  const withRice = features.filter((f) => f.rice_score != null);
  const avgRice =
    withRice.length > 0
      ? Math.round(withRice.reduce((s, f) => s + (f.rice_score ?? 0), 0) / withRice.length)
      : 0;
  const shippedThisQuarter = features.filter((f) => {
    if (f.status !== 'shipped' || !f.shipped_date) return false;
    const shipped = new Date(f.shipped_date);
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    return shipped >= qStart;
  }).length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Product Features</h1>
          {data && <span className="text-sm text-muted-foreground">({totalFeatures})</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Track features from idea to shipped across all stages.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Total features</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{totalFeatures}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Avg RICE</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{avgRice}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Shipped this quarter</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{shippedThisQuarter}</p>
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
              <p className="font-medium">Failed to load features</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {STATUSES.map((s) => {
              const items = features.filter((f) => f.status === s.value);
              return (
                <div key={s.value} className="flex flex-col rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <Badge variant="outline" className={cn('border text-[10px] uppercase', s.color)}>
                      {s.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {items.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">Empty</p>
                    ) : (
                      items.map((f) => (
                        <div
                          key={f.id}
                          className="rounded-md border border-border bg-background p-2 text-xs"
                        >
                          <p className="font-medium" title={f.name}>
                            {f.name}
                          </p>
                          {f.description && (
                            <p
                              className="mt-1 line-clamp-2 text-[10px] text-muted-foreground"
                              title={f.description}
                            >
                              {f.description}
                            </p>
                          )}
                          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                            {f.rice_score != null && (
                              <span className="font-mono">RICE {f.rice_score}</span>
                            )}
                            {f.target_quarter && <span>{f.target_quarter}</span>}
                            {f.status === 'in_progress' && f.progress_pct > 0 && (
                              <span>{f.progress_pct}%</span>
                            )}
                          </div>
                          {f.strategic_theme && (
                            <p className="mt-1 truncate text-[10px] text-muted-foreground">
                              {f.strategic_theme}
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

export const Route = createFileRoute('/features/')({
  component: FeaturesPage,
});
