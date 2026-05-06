import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import { MboxSyncIndicator } from '@/components/mbox/sync-indicator';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

interface EmailMessage {
  id: string;
  subject: string | null;
  from_address: string;
  body_text: string | null;
  body_html: string | null;
  triage_category: string | null;
  triage_reason: string | null;
  received_at: string;
  processed_at: string | null;
}

const ACTIONABLE_CATEGORIES = ['urgent', 'action_needed'] as const;

function categoryColor(category: string | null): string {
  switch (category) {
    case 'urgent':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'action_needed':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'informational':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'fyi':
      return 'bg-gray-100 text-gray-700 border-gray-200';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function MailInboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['inbox', 'actionable'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_messages')
        .select(
          'id, subject, from_address, body_text, body_html, triage_category, triage_reason, received_at, processed_at',
        )
        .in('triage_category', [...ACTIONABLE_CATEGORIES])
        .is('processed_at', null)
        .order('received_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as EmailMessage[];
    },
  });

  const selected = data?.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Unread emails triaged as urgent or action_needed
          {data && <span className="ml-1">· {data.length} actionable</span>}
        </p>
        <MboxSyncIndicator />
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
            <p className="font-medium">Failed to load inbox</p>
            <p className="text-xs opacity-80">{error.message}</p>
            <p className="mt-1 text-xs opacity-60">
              Check VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local, and that
              VITE_SUPABASE_USER_JWT is set if RLS is on.
            </p>
          </div>
        </div>
      )}

      {data && data.length === 0 && !isLoading && (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          Inbox zero. Nothing actionable right now.
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Triage</th>
                <th className="px-3 py-2 text-left font-medium">From</th>
                <th className="px-3 py-2 text-left font-medium">Subject</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr
                  key={m.id}
                  className={cn(
                    'cursor-pointer border-t border-border hover:bg-accent/50',
                    selectedId === m.id && 'bg-accent/40',
                  )}
                >
                  <td className="px-3 py-2 align-top" onClick={() => setSelectedId(m.id)}>
                    <Badge
                      variant="outline"
                      className={cn(
                        'border text-[10px] uppercase',
                        categoryColor(m.triage_category),
                      )}
                    >
                      {m.triage_category ?? '—'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 align-top text-foreground" onClick={() => setSelectedId(m.id)}>
                    <div className="max-w-[18rem] truncate" title={m.from_address}>
                      {m.from_address}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Link
                      to="/mail/$id"
                      params={{ id: m.id }}
                      className="block max-w-[28rem] truncate hover:underline"
                      title={m.subject ?? '(no subject)'}
                    >
                      {m.subject || (
                        <span className="italic text-muted-foreground">(no subject)</span>
                      )}
                    </Link>
                  </td>
                  <td
                    className="px-3 py-2 align-top text-right text-xs text-muted-foreground"
                    onClick={() => setSelectedId(m.id)}
                  >
                    {timeAgo(m.received_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelectedId(null)}>
        <SheetContent side="right" className="w-[36rem] max-w-[90vw] overflow-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-6">
                  {selected.subject || '(no subject)'}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge
                    variant="outline"
                    className={cn(
                      'border text-[10px] uppercase',
                      categoryColor(selected.triage_category),
                    )}
                  >
                    {selected.triage_category ?? '—'}
                  </Badge>
                  <span>{selected.from_address}</span>
                  <span>·</span>
                  <span>{new Date(selected.received_at).toLocaleString()}</span>
                </SheetDescription>
              </SheetHeader>

              {selected.triage_reason && (
                <p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-semibold">Triage reason: </span>
                  {selected.triage_reason}
                </p>
              )}

              <div className="mt-4 whitespace-pre-wrap text-sm">
                {selected.body_text ||
                  (selected.body_html
                    ? selected.body_html.replace(/<[^>]+>/g, '')
                    : '(no body)')}
              </div>

              <div className="mt-4">
                <Link
                  to="/mail/$id"
                  params={{ id: selected.id }}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Open full detail →
                </Link>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export const Route = createFileRoute('/mail/inbox/')({
  component: MailInboxPage,
});
