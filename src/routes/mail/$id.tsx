import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';

interface EmailReplyDraft {
  id: string;
  draft_body: string;
  status: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  rejected_at: string | null;
}

// Raw row shape returned from the email_drafts join via reply_to_message_id.
interface EmailDraftRow {
  id: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  rejected_at: string | null;
}

interface EmailDetail {
  id: string;
  subject: string | null;
  from_address: string;
  to_address: string | null;
  inbox_source: string | null;
  body_text: string | null;
  body_html: string | null;
  triage_category: string | null;
  triage_reason: string | null;
  received_at: string;
  processed_at: string | null;
  email_drafts: EmailDraftRow[] | null;
}

interface LinkedTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  created_at: string;
  completed_at: string | null;
}

const triageColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-800',
  action_needed: 'bg-orange-100 text-orange-800',
  fyi: 'bg-blue-100 text-blue-800',
  ignore: 'bg-gray-100 text-gray-600',
  informational: 'bg-slate-100 text-slate-700',
  replied: 'bg-green-100 text-green-800',
};

const taskStatusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
};

function MailDetailPage() {
  const { id } = Route.useParams();

  const emailQuery = useQuery({
    queryKey: ['emails', 'detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_messages')
        .select(
          '*, email_drafts!reply_to_message_id(id, body, status, created_at, updated_at, approved_at, sent_at, rejected_at)',
        )
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data as EmailDetail | null;
    },
  });

  const tasksQuery = useQuery({
    queryKey: ['tasks', 'by-email', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('id, title, description, status, priority, created_at, completed_at')
        .eq('source_email_id', id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as LinkedTask[];
    },
  });

  const email = emailQuery.data;
  const draftRow = email?.email_drafts?.[0] ?? null;
  const draft: EmailReplyDraft | null = draftRow
    ? {
        id: draftRow.id,
        draft_body: draftRow.body ?? '',
        status: draftRow.status,
        created_at: draftRow.created_at,
        updated_at: draftRow.updated_at,
        approved_at: draftRow.approved_at,
        sent_at: draftRow.sent_at,
        rejected_at: draftRow.rejected_at,
      }
    : null;
  const tasks = tasksQuery.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Link
          to="/mail/all"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
          aria-label="Back to mail"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{email?.subject ?? 'Email'}</h2>
          {email && (
            <p className="truncate text-xs text-muted-foreground">{email.from_address}</p>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {emailQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {emailQuery.error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load email</p>
              <p className="text-xs opacity-80">{emailQuery.error.message}</p>
            </div>
          </div>
        )}

        {email === null && !emailQuery.isLoading && (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            Email not found.
          </div>
        )}

        {email && (
          <>
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div>
                  <span className="font-medium text-muted-foreground">From:</span>{' '}
                  <span>{email.from_address}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">To:</span>{' '}
                  <span>{email.to_address ?? '—'}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Inbox:</span>{' '}
                  <span>{email.inbox_source ?? '—'}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Received:</span>{' '}
                  <span>{new Date(email.received_at).toLocaleString()}</span>
                </div>
              </div>

              {email.triage_category && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">Triage:</span>
                  <span
                    className={cn(
                      'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                      triageColors[email.triage_category] ?? 'bg-gray-100 text-gray-700',
                    )}
                  >
                    {email.triage_category.replace(/_/g, ' ')}
                  </span>
                  {email.triage_reason && (
                    <span className="text-sm text-muted-foreground">
                      — {email.triage_reason}
                    </span>
                  )}
                </div>
              )}

              <div className="mt-4 whitespace-pre-wrap rounded-md bg-muted/30 p-3 text-sm">
                {email.body_text ||
                  (email.body_html ? email.body_html.replace(/<[^>]+>/g, '') : '(empty)')}
              </div>
            </div>

            {tasks.length > 0 && (
              <div className="rounded-lg border border-border bg-card p-5">
                <h2 className="mb-3 text-sm font-semibold">Linked tasks ({tasks.length})</h2>
                <ul className="space-y-2">
                  {tasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start justify-between gap-4 rounded-md border border-border p-3"
                    >
                      <div className="flex-1">
                        <Link
                          to="/tasks/$taskId"
                          params={{ taskId: t.id }}
                          className="text-sm font-medium hover:underline"
                        >
                          {t.title}
                        </Link>
                        {t.description && (
                          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                            {t.description}
                          </p>
                        )}
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                          taskStatusColors[t.status] ?? 'bg-gray-100 text-gray-700',
                        )}
                      >
                        {t.status.replace(/_/g, ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold">Reply draft</h2>
              {draft ? (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Status: <span className="font-medium">{draft.status}</span>
                    <span className="ml-3">
                      Created {new Date(draft.created_at).toLocaleString()}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap rounded-md bg-muted/30 p-3 text-sm font-mono">
                    {draft.draft_body}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Approve / reject actions not yet wired in desktop app — use the web PA app
                    for now.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No reply draft yet for this email.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/mail/$id')({
  component: MailDetailPage,
});
