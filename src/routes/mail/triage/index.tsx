import { useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import { queryKeys } from '@/lib/query-keys';
import {
  nextTriageMessageQuery,
  type TriageCategory,
} from '@/lib/queries/triage';

const CATEGORIES: Array<{ value: TriageCategory; label: string; color: string; key: string }> = [
  { value: 'urgent', label: 'Urgent', color: 'bg-red-100 text-red-800 border-red-200', key: '1' },
  { value: 'action_needed', label: 'Action needed', color: 'bg-amber-100 text-amber-800 border-amber-200', key: '2' },
  { value: 'informational', label: 'Informational', color: 'bg-blue-100 text-blue-800 border-blue-200', key: '3' },
  { value: 'fyi', label: 'FYI', color: 'bg-gray-100 text-gray-700 border-gray-200', key: '4' },
];

function MailTriagePage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery(nextTriageMessageQuery());

  const classify = useMutation({
    mutationFn: async (args: { id: string; category: TriageCategory }) => {
      const { error } = await supabase
        .from('email_messages')
        .update({
          triage_category: args.category,
          triage_reason: 'Manual triage from desktop',
        })
        .eq('id', args.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all });
    },
  });

  const message = data?.message;
  const remaining = data?.remaining ?? 0;

  return (
    <div className="px-6 py-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Classify the next untriaged email. Press 1–4 or click a category.
        {data && <span className="ml-1">· {remaining} remaining</span>}
      </p>

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
            <p className="font-medium">Failed to load triage queue</p>
            <p className="text-xs opacity-80">{error.message}</p>
          </div>
        </div>
      )}

      {!isLoading && !error && !message && (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          Triage zero. No untriaged messages.
        </div>
      )}

      {message && (
        <div className="space-y-4">
          <article className="overflow-hidden rounded-lg border border-border">
            <header className="border-b border-border bg-muted/30 px-4 py-3">
              <h2 className="font-semibold">
                {message.subject || (
                  <span className="italic text-muted-foreground">(no subject)</span>
                )}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{message.from_address}</span>
                <span>·</span>
                <span>{new Date(message.received_at).toLocaleString()}</span>
                {message.triage_reason && (
                  <>
                    <span>·</span>
                    <span title={message.triage_reason}>suggested: {message.triage_reason}</span>
                  </>
                )}
              </div>
            </header>
            <div className="max-h-[24rem] overflow-auto px-4 py-3 text-sm whitespace-pre-wrap">
              {message.body_text ||
                (message.body_html ? message.body_html.replace(/<[^>]+>/g, '') : '(no body)')}
            </div>
          </article>

          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                onClick={() => classify.mutate({ id: message.id, category: c.value })}
                disabled={classify.isPending}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                  'hover:bg-accent disabled:opacity-50',
                )}
              >
                <Badge variant="outline" className={cn('border text-[10px] uppercase', c.color)}>
                  {c.label}
                </Badge>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  {c.key}
                </kbd>
              </button>
            ))}

            <button
              onClick={() => refetch()}
              disabled={classify.isPending}
              className="ml-auto rounded-md border border-input px-3 py-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Skip
            </button>
          </div>

          {classify.isError && (
            <p className="text-xs text-destructive">
              Failed to classify: {(classify.error as Error).message}
            </p>
          )}
        </div>
      )}

      <KeyHandler
        disabled={!message || classify.isPending}
        onPress={(category) => message && classify.mutate({ id: message.id, category })}
      />
    </div>
  );
}

function KeyHandler({
  onPress,
  disabled,
}: {
  onPress: (category: TriageCategory) => void;
  disabled: boolean;
}) {
  useEffect(() => {
    if (disabled) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const map: Record<string, TriageCategory> = {
        '1': 'urgent',
        '2': 'action_needed',
        '3': 'informational',
        '4': 'fyi',
      };
      const cat = map[e.key];
      if (cat) {
        e.preventDefault();
        onPress(cat);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPress, disabled]);
  return null;
}

export const Route = createFileRoute('/mail/triage/')({
  component: MailTriagePage,
});
