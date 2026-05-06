import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

type ContentStatus = 'planned' | 'in_progress' | 'review' | 'scheduled' | 'published';
type ContentType = 'blog' | 'social' | 'newsletter' | 'video' | 'landing_page' | 'help_article';

interface ContentItem {
  id: string;
  title: string;
  type: ContentType | string;
  channel: string | null;
  status: ContentStatus;
  publish_date: string | null;
  author: string | null;
  description: string | null;
  campaign: string | null;
  created_at: string;
}

const STATUSES: Array<{ value: ContentStatus; label: string; color: string }> = [
  { value: 'planned', label: 'Planned', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  {
    value: 'in_progress',
    label: 'In Progress',
    color: 'bg-amber-100 text-amber-800 border-amber-200',
  },
  { value: 'review', label: 'Review', color: 'bg-orange-100 text-orange-800 border-orange-200' },
  {
    value: 'scheduled',
    label: 'Scheduled',
    color: 'bg-blue-100 text-blue-800 border-blue-200',
  },
  {
    value: 'published',
    label: 'Published',
    color: 'bg-green-100 text-green-800 border-green-200',
  },
];

const typeColor: Record<string, string> = {
  blog: 'bg-purple-100 text-purple-800 border-purple-200',
  social: 'bg-pink-100 text-pink-800 border-pink-200',
  newsletter: 'bg-sky-100 text-sky-800 border-sky-200',
  video: 'bg-red-100 text-red-800 border-red-200',
  landing_page: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  help_article: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

function formatDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function ContentPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['content_calendar'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('content_calendar')
        .select('*')
        .order('publish_date', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ContentItem[];
    },
  });

  const items = data ?? [];
  const upcoming = items.filter(
    (i) =>
      i.status !== 'published' && i.publish_date && new Date(i.publish_date) > new Date(),
  );
  const overdue = items.filter(
    (i) =>
      i.status !== 'published' && i.publish_date && new Date(i.publish_date) < new Date(),
  );

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Content calendar</h1>
          {data && <span className="text-sm text-muted-foreground">({items.length})</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Plan, track, and publish content across channels.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Total items</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{items.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Upcoming</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-blue-600">
              {upcoming.length}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Overdue</p>
            <p
              className={cn(
                'mt-1 text-2xl font-bold tabular-nums',
                overdue.length > 0 ? 'text-red-600' : 'text-muted-foreground',
              )}
            >
              {overdue.length}
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
              <p className="font-medium">Failed to load content calendar</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
            {STATUSES.map((s) => {
              const cards = items.filter((i) => i.status === s.value);
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
                      {cards.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {cards.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        Empty
                      </p>
                    ) : (
                      cards.slice(0, 10).map((i) => (
                        <div
                          key={i.id}
                          className="rounded-md border border-border bg-background p-2 text-xs"
                        >
                          <p className="truncate font-medium" title={i.title}>
                            {i.title}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                            <Badge
                              variant="outline"
                              className={cn(
                                'border text-[10px] uppercase',
                                typeColor[i.type] ?? 'bg-gray-100 text-gray-700',
                              )}
                            >
                              {i.type}
                            </Badge>
                            {i.channel && (
                              <span className="text-muted-foreground">{i.channel}</span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>{formatDate(i.publish_date)}</span>
                            {i.author && <span>{i.author}</span>}
                          </div>
                        </div>
                      ))
                    )}
                    {cards.length > 10 && (
                      <p className="px-2 text-center text-[10px] text-muted-foreground">
                        +{cards.length - 10} more
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

export const Route = createFileRoute('/content/')({
  component: ContentPage,
});
