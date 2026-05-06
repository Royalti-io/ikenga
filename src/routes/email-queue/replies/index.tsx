import { useState, useEffect, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  Loader2,
  CheckCircle,
  XCircle,
  Send,
  ChevronDown,
  ChevronUp,
  Reply,
  Inbox,
  AlertTriangle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { paActionsRun } from '@/lib/tauri-cmd';

type ReplyClassification =
  | 'interested'
  | 'question'
  | 'not_now'
  | 'wrong_contact'
  | 'out_of_office'
  | 'unsubscribe';

interface EmailReply {
  id: string;
  classification: ReplyClassification;
  subtype?: string | null;
  status: string;
  subject: string;
  body: string;
  from_name: string;
  from_email: string;
  recipients: { email: string }[];
  cc?: string[] | null;
  error?: string | null;
  created_at: string;
  original_email?: {
    subject?: string;
    from_address?: string;
    received_at?: string;
    body_text?: string;
  } | null;
}

const classificationConfig: Record<
  ReplyClassification,
  { label: string; color: string; icon: string }
> = {
  interested: {
    label: 'Interested',
    color: 'bg-green-100 text-green-800 border-green-300',
    icon: '🔥',
  },
  question: {
    label: 'Question',
    color: 'bg-blue-100 text-blue-800 border-blue-300',
    icon: '❓',
  },
  not_now: {
    label: 'Not Now',
    color: 'bg-amber-100 text-amber-800 border-amber-300',
    icon: '⏸️',
  },
  wrong_contact: {
    label: 'Wrong Contact',
    color: 'bg-purple-100 text-purple-800 border-purple-300',
    icon: '↪️',
  },
  out_of_office: {
    label: 'OOO',
    color: 'bg-gray-100 text-gray-700 border-gray-300',
    icon: '🌴',
  },
  unsubscribe: {
    label: 'Unsubscribe',
    color: 'bg-red-100 text-red-800 border-red-300',
    icon: '🚫',
  },
};

const FILTERS = [
  'pending_review',
  'approved',
  'sent',
  'suppressed',
  'failed',
  'rejected',
  'all',
] as const;
type Filter = (typeof FILTERS)[number];

function EmailRepliesPage() {
  const [replies, setReplies] = useState<EmailReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending_review');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingBody, setEditingBody] = useState<Record<string, string>>({});
  const [editingSubject, setEditingSubject] = useState<Record<string, string>>(
    {},
  );
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const fetchReplies = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data, error: dbErr } = await supabase
        .from('email_replies')
        .select('*, original_email:email_messages(*), parent_draft:email_drafts(id, subject, slug)')
        .eq('status', filter)
        .order('created_at', { ascending: false })
        .limit(100);
      if (dbErr) throw new Error(dbErr.message);
      const list = (data ?? []) as EmailReply[];
      setReplies(list);
      const subjects: Record<string, string> = {};
      const bodies: Record<string, string> = {};
      for (const r of list) {
        subjects[r.id] = r.subject;
        bodies[r.id] = r.body;
      }
      setEditingSubject(subjects);
      setEditingBody(bodies);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchReplies();
  }, [fetchReplies]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function patchReply(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<EmailReply | null> {
    const { data, error: dbErr } = await supabase
      .from('email_replies')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (dbErr) return null;
    return data as EmailReply;
  }

  async function handleApproveAndSend(id: string) {
    setActionLoading(id);
    try {
      const updates: Record<string, unknown> = { status: 'approved' };
      if (editingSubject[id] !== undefined)
        updates.subject = editingSubject[id];
      if (editingBody[id] !== undefined) updates.body = editingBody[id];
      const approved = await patchReply(id, updates);
      if (!approved) throw new Error('Approve failed');

      // pa-actions reply-send is a vendored port of the deleted
      // /api/email-queue/replies/[id]/send route — SMTP via cPanel,
      // In-Reply-To threading, single-row scope.
      const outcome = await paActionsRun('reply-send', [id]);
      if (!outcome.ok) throw new Error(outcome.error ?? 'Send failed');
      setReplies((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveOnly(id: string) {
    setActionLoading(id);
    try {
      const updates: Record<string, unknown> = { status: 'approved' };
      if (editingSubject[id] !== undefined)
        updates.subject = editingSubject[id];
      if (editingBody[id] !== undefined) updates.body = editingBody[id];
      const approved = await patchReply(id, updates);
      if (!approved) throw new Error('Approve failed');
      setReplies((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(id: string) {
    setActionLoading(id);
    try {
      await patchReply(id, {
        status: 'rejected',
        rejection_reason: rejectionReason || null,
      });
      setReplies((prev) => prev.filter((r) => r.id !== id));
      setRejectingId(null);
      setRejectionReason('');
    } catch {
      alert('Reject failed');
    } finally {
      setActionLoading(null);
    }
  }

  function formatDate(d: string): string {
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Replies</h2>

      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium border ${filter === f ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && replies.length === 0 && (
        <div className="rounded-lg border bg-white p-8 text-center">
          <Inbox className="size-8 text-gray-300 mx-auto mb-3" />
          <h3 className="font-medium text-gray-900">
            No {filter.replace('_', ' ')} replies
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Replies handled by Ruby will appear here for your review.
          </p>
        </div>
      )}

      {!loading && !error && replies.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            {replies.length} repl{replies.length === 1 ? 'y' : 'ies'}
          </p>

          {replies.map((item) => {
            const cls = classificationConfig[item.classification];
            const expanded = expandedIds.has(item.id);
            const isAck =
              item.subtype === 'not_now_ack' ||
              item.subtype === 'unsubscribe_ack';

            return (
              <div
                key={item.id}
                className={`rounded-lg border bg-white ${item.status === 'pending_review' ? 'border-amber-200' : 'border-gray-200'}`}
              >
                <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={cls.color}>
                        {cls.icon} {cls.label}
                      </Badge>
                      {item.subtype && (
                        <Badge
                          variant="outline"
                          className="bg-gray-50 text-gray-700"
                        >
                          {item.subtype}
                        </Badge>
                      )}
                      {isAck && (
                        <Badge
                          variant="outline"
                          className="bg-indigo-50 text-indigo-700"
                        >
                          auto-handled
                        </Badge>
                      )}
                      {item.status !== 'pending_review' && (
                        <Badge variant="outline" className="text-xs">
                          {item.status}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                      <span>
                        From: {item.from_name} &lt;{item.from_email}&gt;
                      </span>
                      <span>
                        To: {item.recipients.map((r) => r.email).join(', ')}
                      </span>
                      {Array.isArray(item.cc) && item.cc.length > 0 && (
                        <span>CC: {item.cc.join(', ')}</span>
                      )}
                      <span>Created: {formatDate(item.created_at)}</span>
                    </div>
                    {item.error && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-red-700">
                        <AlertTriangle className="size-3" /> {item.error}
                      </div>
                    )}
                  </div>
                  {item.status === 'pending_review' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          rejectingId === item.id
                            ? setRejectingId(null)
                            : setRejectingId(item.id)
                        }
                        disabled={actionLoading === item.id}
                        className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <XCircle className="size-4" /> Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApproveOnly(item.id)}
                        disabled={actionLoading === item.id}
                        className="flex items-center gap-1.5 rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                      >
                        <CheckCircle className="size-4" /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApproveAndSend(item.id)}
                        disabled={actionLoading === item.id}
                        className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        {actionLoading === item.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                        Approve & Send
                      </button>
                    </div>
                  )}
                </div>

                {rejectingId === item.id && (
                  <div className="border-b border-red-100 bg-red-50 px-4 py-3">
                    <label className="text-xs font-semibold text-red-800 uppercase tracking-wide">
                      Rejection Reason
                    </label>
                    <div className="mt-1 flex gap-2">
                      <input
                        value={rejectionReason}
                        onChange={(e) => setRejectionReason(e.target.value)}
                        placeholder="Why is this being rejected?"
                        className="flex-1 rounded border border-red-300 bg-white px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleReject(item.id)}
                        disabled={actionLoading === item.id}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm Reject
                      </button>
                    </div>
                  </div>
                )}

                <div className="border-b border-gray-100 px-4 py-2 flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide shrink-0">
                    Subject:
                  </span>
                  <input
                    type="text"
                    value={editingSubject[item.id] ?? item.subject}
                    onChange={(e) =>
                      setEditingSubject((prev) => ({
                        ...prev,
                        [item.id]: e.target.value,
                      }))
                    }
                    disabled={item.status !== 'pending_review'}
                    className="flex-1 rounded border border-transparent bg-transparent px-2 py-0.5 text-sm font-medium text-gray-900 hover:border-gray-300 focus:border-green-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-green-500 disabled:cursor-default disabled:hover:border-transparent"
                  />
                </div>

                {item.original_email && (
                  <div className="border-b border-blue-100 bg-blue-50 px-4 py-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Reply className="size-3.5 text-blue-600" />
                      <span className="text-xs font-semibold text-blue-800 uppercase tracking-wide">
                        Replying to
                      </span>
                    </div>
                    <div className="text-sm text-blue-900">
                      <p className="font-medium">
                        {item.original_email.subject}
                      </p>
                      <p className="text-xs text-blue-600 mt-0.5">
                        From: {item.original_email.from_address}
                        {item.original_email.received_at && (
                          <>
                            {' '}
                            &middot; {formatDate(item.original_email.received_at)}
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => toggleExpanded(item.id)}
                  className="w-full border-b border-gray-100 px-4 py-2 flex items-center justify-between text-xs font-semibold text-gray-500 uppercase tracking-wide hover:bg-gray-50"
                >
                  <span>Draft Body</span>
                  {expanded ? (
                    <ChevronUp className="size-4" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                </button>

                {expanded && (
                  <div className="p-4">
                    <textarea
                      value={editingBody[item.id] ?? item.body}
                      onChange={(e) =>
                        setEditingBody((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      disabled={item.status !== 'pending_review'}
                      rows={Math.max(
                        8,
                        (editingBody[item.id] ?? item.body).split('\n').length +
                          2,
                      )}
                      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 font-mono focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:bg-gray-50"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/email-queue/replies/')({
  component: EmailRepliesPage,
});
