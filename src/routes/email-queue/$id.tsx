import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  CheckCircle,
  XCircle,
  Save,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  emailDraftDetailQuery,
  type EmailDraftStatus,
} from '@/lib/queries/email-drafts';
import { queryKeys } from '@/lib/query-keys';

const statusConfig: Record<
  EmailDraftStatus,
  { label: string; color: string }
> = {
  draft: { label: 'Draft', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  pending_review: {
    label: 'Pending Review',
    color: 'bg-orange-100 text-orange-800 border-orange-200',
  },
  approved: { label: 'Approved', color: 'bg-green-100 text-green-800 border-green-200' },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800 border-red-200' },
  scheduled: { label: 'Scheduled', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  sending: { label: 'Sending', color: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  sent: { label: 'Sent', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-800 border-red-200' },
};

function EmailDraftDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery(emailDraftDetailQuery(id));

  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const editingSubject = subject ?? data?.subject ?? '';
  const editingBody = body ?? data?.body ?? '';

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.emailDrafts.all });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const updates: Record<string, unknown> = {
        subject: editingSubject,
        body: editingBody,
      };
      const { error } = await supabase
        .from('email_drafts')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const updates: Record<string, unknown> = {
        status: 'approved',
        subject: editingSubject,
        body: editingBody,
        approved_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from('email_drafts')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      navigate({ to: '/email-queue' });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('email_drafts')
        .update({
          status: 'rejected',
          rejected_at: new Date().toISOString(),
          rejection_reason: rejectionReason || null,
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      navigate({ to: '/email-queue' });
    },
  });

  const status = data ? statusConfig[data.status] ?? statusConfig.draft : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            to="/email-queue"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
            aria-label="Back to queue"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold">Email draft</h1>
            {data && (
              <p className="text-xs text-muted-foreground">
                {data.from_name} &lt;{data.from_email}&gt;
              </p>
            )}
          </div>
        </div>

        {status && (
          <Badge
            variant="outline"
            className={cn('border text-[10px] uppercase', status.color)}
          >
            {status.label}
          </Badge>
        )}
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
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
              <p className="font-medium">Failed to load draft</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Subject
              </label>
              <input
                type="text"
                value={editingSubject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Body
              </label>
              <textarea
                value={editingBody}
                onChange={(e) => setBody(e.target.value)}
                rows={20}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div>
                <span className="font-semibold">Delivery:</span>{' '}
                {data.delivery_system}
              </div>
              {data.scheduled_for && (
                <div>
                  <span className="font-semibold">Scheduled for:</span>{' '}
                  {new Date(data.scheduled_for).toLocaleString()}
                </div>
              )}
              {data.sequence && (
                <div>
                  <span className="font-semibold">Sequence:</span>{' '}
                  {data.sequence.name}
                  {data.sequence_step != null && ` (step ${data.sequence_step})`}
                </div>
              )}
              {data.recipients && data.recipients.length > 0 && (
                <div>
                  <span className="font-semibold">Recipients:</span>{' '}
                  {data.recipients.length}
                </div>
              )}
            </div>

            {data.rejection_reason && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                <span className="font-semibold">Rejected:</span>{' '}
                {data.rejection_reason}
              </div>
            )}

            {(data.status === 'draft' ||
              data.status === 'pending_review' ||
              data.status === 'rejected') && (
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Rejection reason (optional)
                </label>
                <input
                  type="text"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Why are you rejecting this?"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            )}
          </>
        )}
      </div>

      {data && (
        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            Save edits
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              rejectMutation.isPending ||
              data.status === 'sent' ||
              data.status === 'sending'
            }
            onClick={() => rejectMutation.mutate()}
            className="text-red-700"
          >
            {rejectMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="mr-1 h-3.5 w-3.5" />
            )}
            Reject
          </Button>
          <Button
            size="sm"
            disabled={
              approveMutation.isPending ||
              data.status === 'sent' ||
              data.status === 'sending' ||
              data.status === 'approved'
            }
            onClick={() => approveMutation.mutate()}
          >
            {approveMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle className="mr-1 h-3.5 w-3.5" />
            )}
            Approve
          </Button>
        </footer>
      )}
    </div>
  );
}

export const Route = createFileRoute('/email-queue/$id')({
  component: EmailDraftDetailPage,
});
