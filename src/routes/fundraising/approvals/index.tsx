import { useState, useEffect, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import {
  Loader2,
  CheckCircle,
  XCircle,
  Mail,
  Share2 as Linkedin,
  Users,
  Send,
  FileText,
  Save,
  Pencil,
  RotateCcw,
} from 'lucide-react';

// Local minimal types — full types live in ikenga/lib/types/fundraising.
interface FundraisingDeal {
  id: string;
  investor_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
}

interface FundraisingOutreach {
  id: string;
  channel: string;
  body: string;
  subject?: string | null;
  sequence_number: number;
  drafted_by: string;
  created_at: string;
  application_url?: string | null;
  application_deadline?: string | null;
}

type OutreachWithDeal = FundraisingOutreach & { deal: FundraisingDeal };

const channelConfig: Record<string, { label: string; icon: typeof Mail; color: string }> = {
  email: { label: 'Email', icon: Mail, color: 'bg-blue-100 text-blue-700' },
  linkedin: { label: 'LinkedIn', icon: Linkedin, color: 'bg-sky-100 text-sky-700' },
  intro_request: { label: 'Warm Intro', icon: Users, color: 'bg-purple-100 text-purple-700' },
  application: { label: 'Application', icon: FileText, color: 'bg-green-100 text-green-700' },
};

function FundraisingApprovalsPage() {
  const [outreach, setOutreach] = useState<OutreachWithDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState<Record<string, string>>({});
  const [editingSubject, setEditingSubject] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [showRejectInput, setShowRejectInput] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const fetchOutreach = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data: rows, error: dbErr } = await supabase
        .from('fundraising_outreach')
        .select('*, deal:fundraising_deals(*)')
        .eq('status', 'pending_approval')
        .order('created_at', { ascending: false })
        .limit(100);
      if (dbErr) throw new Error(dbErr.message);
      const data = (rows ?? []) as OutreachWithDeal[];
      setOutreach(data);
      const bodies: Record<string, string> = {};
      const subjects: Record<string, string> = {};
      for (const o of data) {
        bodies[o.id] = o.body;
        subjects[o.id] = o.subject ?? '';
      }
      setEditingBody(bodies);
      setEditingSubject(subjects);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOutreach();
  }, [fetchOutreach]);

  function isEdited(item: OutreachWithDeal): boolean {
    const bodyChanged =
      editingBody[item.id] !== undefined && editingBody[item.id] !== item.body;
    const subjectChanged =
      editingSubject[item.id] !== undefined &&
      editingSubject[item.id] !== (item.subject ?? '');
    return bodyChanged || subjectChanged;
  }

  async function handleSaveDraft(id: string) {
    setSavingId(id);
    try {
      const updates: Record<string, unknown> = {};
      if (editingBody[id] !== undefined) updates.body = editingBody[id];
      if (editingSubject[id] !== undefined) updates.subject = editingSubject[id] || null;

      const { data: updated, error: dbErr } = await supabase
        .from('fundraising_outreach')
        .update(updates)
        .eq('id', id)
        .select('body, subject')
        .single();
      if (dbErr) throw new Error(dbErr.message);

      setOutreach((prev) =>
        prev.map((o) =>
          o.id === id ? { ...o, body: updated.body, subject: updated.subject } : o,
        ),
      );
      setSavedIds((prev) => new Set(prev).add(id));
      setTimeout(
        () =>
          setSavedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
        2000,
      );
    } catch {
      alert('Save failed');
    } finally {
      setSavingId(null);
    }
  }

  function handleResetEdits(item: OutreachWithDeal) {
    setEditingBody((prev) => ({ ...prev, [item.id]: item.body }));
    setEditingSubject((prev) => ({ ...prev, [item.id]: item.subject ?? '' }));
  }

  async function handleApprove(id: string) {
    setActionLoading(id);
    try {
      const updates: Record<string, unknown> = { status: 'approved' };
      if (editingBody[id] !== undefined) updates.body = editingBody[id];
      if (editingSubject[id] !== undefined) updates.subject = editingSubject[id] || null;

      const { error: dbErr } = await supabase
        .from('fundraising_outreach')
        .update(updates)
        .eq('id', id);
      if (dbErr) throw new Error(dbErr.message);
      setOutreach((prev) => prev.filter((o) => o.id !== id));
    } catch {
      alert('Approve failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(id: string) {
    const reason = rejectReason[id]?.trim();
    if (!reason) {
      setShowRejectInput(id);
      return;
    }

    setActionLoading(id);
    try {
      const { error: dbErr } = await supabase
        .from('fundraising_outreach')
        .update({ status: 'rejected', rejected_reason: reason })
        .eq('id', id);
      if (dbErr) throw new Error(dbErr.message);
      setOutreach((prev) => prev.filter((o) => o.id !== id));
      setShowRejectInput(null);
    } catch {
      alert('Reject failed');
    } finally {
      setActionLoading(null);
    }
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  return (
    <div className="space-y-4 px-6 py-4">
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

      {!loading && !error && outreach.length === 0 && (
        <div className="rounded-lg border bg-white p-8 text-center">
          <CheckCircle className="size-8 text-green-400 mx-auto mb-3" />
          <h3 className="font-medium text-gray-900">No outreach pending approval</h3>
          <p className="mt-1 text-sm text-gray-500">
            The fundraising agent will draft outreach for qualified investors.
          </p>
        </div>
      )}

      {!loading && !error && outreach.length > 0 && (
        <>
          <p className="text-sm text-gray-500">
            {outreach.length} outreach draft{outreach.length !== 1 ? 's' : ''} awaiting your
            review
          </p>

          {outreach.map((item) => {
            const channel = channelConfig[item.channel] ?? channelConfig.email;
            const ChannelIcon = channel.icon;
            const edited = isEdited(item);
            const saved = savedIds.has(item.id);

            return (
              <div
                key={item.id}
                className={`rounded-lg border bg-white ${edited ? 'border-blue-300 ring-1 ring-blue-100' : 'border-amber-200'}`}
              >
                <div className="flex items-start justify-between gap-4 border-b border-amber-100 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">
                        {item.deal?.investor_name ?? 'Unknown Investor'}
                      </h3>
                      <Badge variant="outline" className={channel.color}>
                        <ChannelIcon className="size-3 mr-1" />
                        {channel.label}
                      </Badge>
                      {item.sequence_number > 1 && (
                        <Badge variant="outline" className="text-xs">
                          Follow-up #{item.sequence_number}
                        </Badge>
                      )}
                      {edited && (
                        <Badge
                          variant="outline"
                          className="bg-blue-50 text-blue-700 border-blue-200 text-xs"
                        >
                          <Pencil className="size-3 mr-1" />
                          Edited
                        </Badge>
                      )}
                      {saved && (
                        <Badge
                          variant="outline"
                          className="bg-green-50 text-green-700 border-green-200 text-xs"
                        >
                          <CheckCircle className="size-3 mr-1" />
                          Saved
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                      {item.deal?.contact_name && <span>To: {item.deal.contact_name}</span>}
                      {item.deal?.contact_email && <span>{item.deal.contact_email}</span>}
                      <span>Drafted by: {item.drafted_by}</span>
                      <span>{formatDate(item.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {edited && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleResetEdits(item)}
                          className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50"
                          title="Reset to original"
                        >
                          <RotateCcw className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveDraft(item.id)}
                          disabled={savingId === item.id}
                          className="flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {savingId === item.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Save className="size-4" />
                          )}
                          Save
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => handleReject(item.id)}
                      disabled={actionLoading === item.id}
                      className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <XCircle className="size-4" />
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprove(item.id)}
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
                </div>

                {(item.channel === 'email' || item.subject) && (
                  <div className="border-b border-amber-100 px-4 py-2 flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide shrink-0">
                      Subject:
                    </span>
                    <input
                      type="text"
                      value={editingSubject[item.id] ?? item.subject ?? ''}
                      onChange={(e) =>
                        setEditingSubject((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      placeholder="Email subject line..."
                      className="flex-1 rounded border border-transparent bg-transparent px-2 py-0.5 text-sm text-gray-900 hover:border-gray-300 focus:border-green-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </div>
                )}

                {item.channel === 'application' &&
                  (item.application_url || item.application_deadline) && (
                    <div className="border-b border-amber-100 px-4 py-2 flex gap-4 text-sm">
                      {item.application_url && (
                        <span>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            URL:{' '}
                          </span>
                          <a
                            href={item.application_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {item.application_url}
                          </a>
                        </span>
                      )}
                      {item.application_deadline && (
                        <span>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            Deadline:{' '}
                          </span>
                          <span className="text-gray-900 font-medium">
                            {item.application_deadline}
                          </span>
                        </span>
                      )}
                    </div>
                  )}

                <div className="p-4">
                  <div
                    className={`rounded-lg border p-3 ${edited ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}
                  >
                    <h4
                      className={`text-xs font-semibold mb-2 uppercase tracking-wide ${edited ? 'text-blue-800' : 'text-amber-800'}`}
                    >
                      {item.channel === 'application'
                        ? 'Draft Answers (editable)'
                        : 'Message Draft (editable)'}
                    </h4>
                    <textarea
                      value={editingBody[item.id] ?? item.body}
                      onChange={(e) =>
                        setEditingBody((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                      rows={Math.max(
                        4,
                        (editingBody[item.id] ?? item.body).split('\n').length + 1,
                      )}
                      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </div>
                </div>

                {showRejectInput === item.id && (
                  <div className="border-t border-amber-100 p-4">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Reason for rejection
                    </label>
                    <div className="mt-1 flex gap-2">
                      <input
                        type="text"
                        value={rejectReason[item.id] ?? ''}
                        onChange={(e) =>
                          setRejectReason((prev) => ({
                            ...prev,
                            [item.id]: e.target.value,
                          }))
                        }
                        placeholder="e.g., Wrong tone, needs more personalization..."
                        className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleReject(item.id);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => handleReject(item.id)}
                        disabled={!rejectReason[item.id]?.trim()}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRejectInput(null)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/fundraising/approvals/')({
  component: FundraisingApprovalsPage,
});
