import { useMemo, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';

interface EmailRow {
  id: string;
  subject: string | null;
  from_address: string;
  to_address: string | null;
  inbox_source: string | null;
  triage_category: string | null;
  triage_reason: string | null;
  received_at: string;
  processed_at: string | null;
  has_draft?: boolean;
}

const TRIAGE_OPTIONS = [
  { value: '', label: 'All triage' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'action_needed', label: 'Action needed' },
  { value: 'informational', label: 'Informational' },
  { value: 'fyi', label: 'FYI' },
  { value: 'replied', label: 'Replied' },
  { value: 'ignore', label: 'Ignore' },
];

const PAGE_SIZE = 50;

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
    case 'replied':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'ignore':
      return 'bg-gray-100 text-gray-500 border-gray-200';
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

function MailAllPage() {
  const [triage, setTriage] = useState('');
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['emails', 'list', triage, search],
    queryFn: async () => {
      let q = supabase
        .from('email_messages')
        .select(
          'id, subject, from_address, to_address, inbox_source, triage_category, triage_reason, received_at, processed_at',
        )
        .order('received_at', { ascending: false })
        .limit(PAGE_SIZE);

      if (triage) q = q.eq('triage_category', triage);
      if (search) {
        q = q.or(`subject.ilike.%${search}%,from_address.ilike.%${search}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as EmailRow[];
    },
  });

  const items = useMemo(() => data ?? [], [data]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search subject or sender…"
          className="w-72 max-w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        <select
          value={triage}
          onChange={(e) => setTriage(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          {TRIAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {(triage || search) && (
          <button
            onClick={() => {
              setTriage('');
              setSearch('');
            }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Clear
          </button>
        )}
        {data && (
          <span className="ml-auto text-xs text-muted-foreground">{items.length} results</span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
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
              <p className="font-medium">Failed to load emails</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && items.length === 0 && !isLoading && (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No emails match these filters.
          </div>
        )}

        {data && items.length > 0 && (
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
                {items.map((m) => (
                  <tr
                    key={m.id}
                    className="cursor-pointer border-t border-border hover:bg-accent/50"
                  >
                    <td className="px-3 py-2 align-top">
                      <Link to="/mail/$id" params={{ id: m.id }} className="block">
                        <Badge
                          variant="outline"
                          className={cn(
                            'border text-[10px] uppercase',
                            categoryColor(m.triage_category),
                          )}
                        >
                          {m.triage_category ?? '—'}
                        </Badge>
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        to="/mail/$id"
                        params={{ id: m.id }}
                        className="block max-w-[18rem] truncate text-foreground"
                        title={m.from_address}
                      >
                        {m.from_address}
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        to="/mail/$id"
                        params={{ id: m.id }}
                        className="block max-w-[28rem] truncate"
                        title={m.subject ?? '(no subject)'}
                      >
                        {m.subject || (
                          <span className="italic text-muted-foreground">(no subject)</span>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top text-right text-xs text-muted-foreground">
                      {timeAgo(m.received_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/mail/all/')({
  component: MailAllPage,
});
