import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';

type DraftStatus = 'pending_review' | 'approved' | 'sent' | 'rejected';

const STATUS_ORDER: DraftStatus[] = ['pending_review', 'approved', 'sent', 'rejected'];

const statusLabels: Record<DraftStatus, string> = {
  pending_review: 'Pending',
  approved: 'Approved',
  sent: 'Sent',
  rejected: 'Rejected',
};

const statusColors: Record<DraftStatus, string> = {
  pending_review: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  sent: 'bg-blue-100 text-blue-800',
  rejected: 'bg-red-100 text-red-800',
};

const triageColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-800',
  action_needed: 'bg-orange-100 text-orange-800',
  fyi: 'bg-blue-100 text-blue-800',
  informational: 'bg-slate-100 text-slate-700',
  replied: 'bg-green-100 text-green-800',
};

interface DraftRow {
  id: string;
  email_message_id: string;
  draft_body: string;
  status: DraftStatus;
  created_at: string;
  email_messages: {
    id: string;
    subject: string | null;
    from_address: string;
    received_at: string;
    triage_category: string | null;
  } | null;
}

// Reads from email_drafts (canonical) filtered to inbox-reply drafts via
// reply_to_message_id IS NOT NULL. The UI shape (DraftRow) is preserved
// by mapping body→draft_body and resolving the joined email_messages row.
function MailDraftsPage() {
  const [selectedStatus, setSelectedStatus] = useState<DraftStatus>('pending_review');

  const countsQuery = useQuery({
    queryKey: ['email_drafts', 'reply', 'counts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select('status')
        .not('reply_to_message_id', 'is', null);
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const s of STATUS_ORDER) counts[s] = 0;
      for (const row of (data ?? []) as { status: string }[]) {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
      }
      return counts;
    },
  });

  const draftsQuery = useQuery({
    queryKey: ['email_drafts', 'reply', 'list', selectedStatus],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select(
          `id, reply_to_message_id, body, status, created_at,
           email_messages!reply_to_message_id (id, subject, from_address, received_at, triage_category)`,
        )
        .not('reply_to_message_id', 'is', null)
        .eq('status', selectedStatus)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []).map((d: any) => ({
        id: d.id,
        email_message_id: d.reply_to_message_id,
        draft_body: d.body ?? '',
        status: d.status,
        created_at: d.created_at,
        email_messages: d.email_messages ?? null,
      })) as DraftRow[];
    },
  });

  const drafts = draftsQuery.data ?? [];
  const counts = countsQuery.data ?? {};

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-border bg-background px-6 py-2">
        {STATUS_ORDER.map((s) => {
          const active = s === selectedStatus;
          return (
            <button
              key={s}
              onClick={() => setSelectedStatus(s)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {statusLabels[s]}
              <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {counts[s] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {draftsQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {draftsQuery.error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load drafts</p>
              <p className="text-xs opacity-80">{draftsQuery.error.message}</p>
            </div>
          </div>
        )}

        {drafts.length === 0 && !draftsQuery.isLoading && (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No {statusLabels[selectedStatus].toLowerCase()} drafts.
          </div>
        )}

        {drafts.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Subject</th>
                  <th className="px-3 py-2 text-left font-medium">Preview</th>
                  <th className="px-3 py-2 text-left font-medium">Triage</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Drafted</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const email = d.email_messages;
                  const preview = d.draft_body.replace(/\s+/g, ' ').slice(0, 120);
                  const ageDays = Math.floor(
                    (Date.now() - new Date(d.created_at).getTime()) / (1000 * 60 * 60 * 24),
                  );
                  return (
                    <tr
                      key={d.id}
                      className="cursor-pointer border-t border-border hover:bg-accent/50"
                    >
                      <td className="px-3 py-2 align-top">
                        <Link
                          to="/mail/$id"
                          params={{ id: d.email_message_id }}
                          className="block"
                        >
                          <div
                            className="max-w-[18rem] truncate font-medium"
                            title={email?.subject ?? ''}
                          >
                            {email?.subject ?? '(no subject)'}
                          </div>
                          <div
                            className="max-w-[18rem] truncate text-xs text-muted-foreground"
                            title={email?.from_address ?? ''}
                          >
                            from {email?.from_address ?? '(unknown)'}
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        <p className="max-w-md truncate">{preview}</p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {email?.triage_category && (
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-xs font-medium',
                              triageColors[email.triage_category] ?? 'bg-gray-100 text-gray-700',
                            )}
                          >
                            {email.triage_category.replace(/_/g, ' ')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            statusColors[d.status],
                          )}
                        >
                          {statusLabels[d.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top text-right text-xs text-muted-foreground">
                        {ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays}d ago`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/mail/drafts/')({
  component: MailDraftsPage,
});
