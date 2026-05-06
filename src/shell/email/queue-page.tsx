import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Send,
  XCircle,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { paActionsRun } from '@/lib/tauri-cmd';
import { queryKeys } from '@/lib/query-keys';
import {
  emailDraftsListQuery,
  type EmailDraft,
} from '@/lib/queries/email-drafts';
import { crmLookupQuery } from '@/lib/queries/crm-lookup';
import { HandoffButtons } from '@/routes/outbox/-components/handoff-buttons';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';
import { ReplyIntelligence } from './reply-intelligence';
import { buildEmailHandoffSeed } from './handoff-seed';
import { BodyPane } from './body-pane';

const REJECT_REASONS = [
  'Wrong recipient',
  'Tone is off',
  'Misses context',
  'Already replied elsewhere',
  "Don't send · close out",
];

type SourceKey = 'reply' | 'manual' | 'sequence' | 'agent';
const SOURCE_LABEL: Record<SourceKey, string> = {
  reply: 'Replies',
  manual: 'Manual',
  sequence: 'Sequence step',
  agent: 'Agent',
};
const SOURCE_ORDER: SourceKey[] = ['reply', 'manual', 'sequence', 'agent'];

function inferSource(d: EmailDraft): SourceKey {
  if (d.reply_to_message_id) return 'reply';
  if (d.sequence_id) return 'sequence';
  if (!d.created_by || d.created_by === 'manual') return 'manual';
  return 'agent';
}

function primaryRecipient(d: EmailDraft): string {
  const recipients = d.recipients ?? [];
  if (recipients.length === 0) return '—';
  if (recipients.length === 1) {
    const r = recipients[0]!;
    return r.name ? `${r.name} <${r.email}>` : r.email;
  }
  return `${recipients.length} recipients`;
}

function primaryEmailAddress(d: EmailDraft): string | null {
  const recipients = d.recipients ?? [];
  if (recipients.length === 0) return null;
  return recipients[0]?.email ?? null;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const delta = Date.now() - t;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isOverdue(d: EmailDraft): boolean {
  if (!d.scheduled_for) return false;
  return new Date(d.scheduled_for).getTime() < Date.now();
}

function overdueLabel(d: EmailDraft): string | null {
  if (!d.scheduled_for) return null;
  const delta = Date.now() - new Date(d.scheduled_for).getTime();
  if (delta <= 0) return null;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `${hours}h late`;
  const days = Math.floor(hours / 24);
  return `${days}d late`;
}

export function EmailQueuePage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery(emailDraftsListQuery());

  const drafts = useMemo(() => {
    const all = data ?? [];
    // Email queue excludes newsletter + investor_update (those live in /outbox/newsletter).
    return all.filter(
      (d) =>
        ['draft', 'pending_review'].includes(d.status) &&
        d.type !== 'newsletter' &&
        d.type !== 'investor_update',
    );
  }, [data]);

  const groups = useMemo(() => {
    const out: Record<SourceKey, EmailDraft[]> = {
      reply: [],
      manual: [],
      sequence: [],
      agent: [],
    };
    for (const d of drafts) {
      out[inferSource(d)].push(d);
    }
    // Oldest first (longer it sits, more it costs).
    for (const k of SOURCE_ORDER) {
      out[k].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    }
    return out;
  }, [drafts]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && drafts.some((d) => d.id === selectedId)) return;
    setSelectedId(drafts[0]?.id ?? null);
  }, [drafts, selectedId]);

  const selected = selectedId
    ? drafts.find((d) => d.id === selectedId) ?? null
    : null;

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--fg-muted)' }}>
        <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} aria-hidden />
      </div>
    );
  }
  if (error instanceof Error) {
    return (
      <div className="ob-error" style={{ margin: 'var(--space-3)' }}>
        <AlertCircle aria-hidden style={{ width: 14, height: 14 }} />
        Failed to load email drafts: {error.message}
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <div className="ob-empty" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
        <h3>Inbox at zero</h3>
        <p>No drafts pending review. Replies land here automatically when Ruby drafts them.</p>
      </div>
    );
  }

  return (
    <div className="nl-split em-md">
      <div className="nl-master em-master">
        {SOURCE_ORDER.map((key) => {
          const list = groups[key];
          if (list.length === 0) return null;
          return (
            <div key={key}>
              <div className="nl-master-group-head">
                {SOURCE_LABEL[key]} · {list.length}
              </div>
              {list.map((d) => (
                <DraftRow
                  key={d.id}
                  draft={d}
                  selected={d.id === selectedId}
                  onClick={() => setSelectedId(d.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="nl-detail em-detail">
        {selected ? (
          <DraftDetail
            draft={selected}
            invalidate={() =>
              queryClient.invalidateQueries({ queryKey: queryKeys.emailDrafts.all })
            }
          />
        ) : (
          <div className="nl-detail-empty">Select a draft to review.</div>
        )}
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  selected,
  onClick,
}: {
  draft: EmailDraft;
  selected: boolean;
  onClick: () => void;
}) {
  const overdue = isOverdue(draft);
  const overdueLbl = overdueLabel(draft);
  const source = inferSource(draft);
  const recipient = primaryRecipient(draft);
  return (
    <div
      className={`em-row${selected ? ' is-on' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      <div className="em-row-line1">
        <span className="em-row-from">{recipient}</span>
        <span className="em-row-time">{relativeTime(draft.created_at)}</span>
      </div>
      <div className="em-row-subj">{draft.subject || '— no subject —'}</div>
      <div className="em-row-snip">{draft.body.slice(0, 140)}</div>
      <div className="em-row-foot">
        {overdue && overdueLbl && (
          <span className="ob-chip ob-chip-warn">overdue · {overdueLbl}</span>
        )}
        <span className="ob-chip">{source}</span>
        {draft.sequence_id && draft.sequence_step != null && (
          <span className="ob-chip ob-chip-tint">
            step {draft.sequence_step}
            {draft.sequence?.slug ? ` · ${draft.sequence.slug}` : ''}
          </span>
        )}
        {draft.created_by && draft.created_by !== 'manual' && source !== 'sequence' && (
          <span className="ob-chip">{draft.created_by}</span>
        )}
      </div>
    </div>
  );
}

function DraftDetail({
  draft,
  invalidate,
}: {
  draft: EmailDraft;
  invalidate: () => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [scheduled, setScheduled] = useState(draft.scheduled_for ?? '');
  const [savedToast, setSavedToast] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [seedOpen, setSeedOpen] = useState(false);

  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
    setScheduled(draft.scheduled_for ?? '');
    setRejecting(false);
    setRejectionReason('');
  }, [draft.id]);

  const recipientEmail = primaryEmailAddress(draft);
  const intelQuery = useQuery(crmLookupQuery(recipientEmail));

  const isPending = ['draft', 'pending_review'].includes(draft.status);

  const edited =
    subject !== draft.subject ||
    body !== draft.body ||
    scheduled !== (draft.scheduled_for ?? '');

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('email_drafts')
        .update({
          subject,
          body,
          scheduled_for: scheduled || null,
        })
        .eq('id', draft.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1500);
      invalidate();
    },
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('email_drafts')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          subject,
          body,
          scheduled_for: scheduled || null,
        })
        .eq('id', draft.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const approveAndSendMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('email_drafts')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          subject,
          body,
          scheduled_for: scheduled || null,
        })
        .eq('id', draft.id);
      if (error) throw error;

      const outcome = await paActionsRun('email-send', [draft.id]);
      if (!outcome.ok) {
        throw new Error(outcome.error ?? 'email-send failed (see agent_runs)');
      }
      return outcome;
    },
    onSuccess: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: async (reason: string | null) => {
      const { error } = await supabase
        .from('email_drafts')
        .update({
          status: 'rejected',
          rejection_reason: reason,
          rejected_at: new Date().toISOString(),
        })
        .eq('id', draft.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setRejecting(false);
      setRejectionReason('');
      invalidate();
    },
  });

  const busy =
    saveMutation.isPending ||
    approveMutation.isPending ||
    approveAndSendMutation.isPending ||
    rejectMutation.isPending;

  const overdueLbl = overdueLabel(draft);
  const source = inferSource(draft);

  const seedPrompt = buildEmailHandoffSeed({
    subject,
    body,
    toAddress: recipientEmail,
    fromAddress: draft.from_email,
    intel: intelQuery.data ?? null,
  });

  return (
    <>
      <div className="em-detail-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <span className="ob-chip">{draft.delivery_system} · {source}</span>
            {draft.sequence_id && draft.sequence_step != null && (
              <span className="ob-chip ob-chip-tint">
                step {draft.sequence_step} of {draft.sequence?.slug ?? '?'}
              </span>
            )}
            {overdueLbl && (
              <span className="ob-chip ob-chip-warn">overdue · {overdueLbl}</span>
            )}
            {edited && (
              <span className="ob-chip ob-chip-tint">
                <Pencil aria-hidden /> Edited
              </span>
            )}
          </div>
          <h2 className="em-detail-subject">{subject || '— no subject —'}</h2>
          <div className="em-detail-meta">
            {recipientEmail && <span><b>To</b> {primaryRecipient(draft)}</span>}
            <span><b>From</b> {draft.from_email}</span>
            <span><b>Created</b> {new Date(draft.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            {draft.slug && <span><b>Slug</b> {draft.slug}</span>}
          </div>
        </div>
      </div>

      <ReplyIntelligence email={recipientEmail} />

      {rejecting && (
        <div className="nl-reject">
          <label htmlFor="email-reject-reason">Why are you rejecting this draft?</label>
          <div className="canned">
            {REJECT_REASONS.map((r) => (
              <button type="button" key={r} onClick={() => setRejectionReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <div className="rrow">
            <input
              id="email-reject-reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Add detail (optional, feeds writer-agent dataset)"
              autoFocus
            />
            <button className="ob-btn" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              className="ob-btn ob-btn-danger-solid"
              onClick={() => rejectMutation.mutate(rejectionReason || null)}
              disabled={busy}
            >
              Confirm reject
            </button>
          </div>
        </div>
      )}

      <div className="em-body">
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={!isPending}
          placeholder="Subject"
          style={{
            width: '100%',
            background: 'var(--bg-base)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-2) var(--space-3)',
            color: 'var(--fg)',
            fontSize: 'var(--text-body)',
            fontFamily: 'inherit',
            marginBottom: 'var(--space-3)',
            outline: 'none',
          }}
        />
        <BodyPane
          body={body}
          format={draft.body_format}
          onChange={setBody}
          disabled={!isPending}
          textareaClassName="em-body-textarea"
        />
      </div>

      <div className="nl-actions">
        <span className="meta">
          {scheduled
            ? `Schedule · ${new Date(scheduled).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
            : 'not scheduled'}{' '}· {draft.delivery_system}
        </span>
        <span className="spacer" />
        <HandoffButtons
          draftId={draft.id}
          draftTitle={subject}
          draftBody={seedPrompt}
          agentSlug={draft.created_by ?? undefined}
        />
        {savedToast && (
          <span className="ob-chip ob-chip-ok">Saved</span>
        )}
        {isPending && (
          <>
            <button
              type="button"
              className="ob-btn ob-btn-danger"
              onClick={() => setRejecting((r) => !r)}
              disabled={busy}
            >
              <XCircle aria-hidden /> Reject…
            </button>
            {edited && (
              <>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => {
                    setSubject(draft.subject);
                    setBody(draft.body);
                    setScheduled(draft.scheduled_for ?? '');
                  }}
                  title="Reset to original"
                >
                  <RotateCcw aria-hidden />
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => saveMutation.mutate()}
                  disabled={busy}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Save aria-hidden />
                  )}
                  Save
                </button>
              </>
            )}
            <button
              type="button"
              className="ob-btn"
              onClick={() => approveMutation.mutate()}
              disabled={busy}
              title="Approve and let cron deliver at the scheduled time"
            >
              {approveMutation.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Approve & schedule
            </button>
            <button
              type="button"
              className="ob-btn ob-btn-primary"
              onClick={() => {
                if (approveAndSendMutation.isPending) return;
                approveAndSendMutation.mutate(undefined, {
                  onError: (err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    window.alert(`Send failed: ${msg}\n\nDraft is still 'approved'; cron will retry at next tick.`);
                  },
                });
              }}
              disabled={busy}
              title="Approve and send immediately via the actions sidecar"
            >
              {approveAndSendMutation.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Approve & Send Now
            </button>
          </>
        )}
      </div>

      <NewSessionDialog
        open={seedOpen}
        onOpenChange={setSeedOpen}
        presetPrompt={seedPrompt}
      />
    </>
  );
}
