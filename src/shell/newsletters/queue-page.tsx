import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Send,
  SkipForward,
  XCircle,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import {
  newsletterDraftsListQuery,
  type EmailDraft,
} from '@/lib/queries/email-drafts';
import { queryKeys } from '@/lib/query-keys';
import { getNextSlot } from '@/lib/newsletters/schedule';
import { HandoffButtons } from '@/routes/outbox/-components/handoff-buttons';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';
import { BodyPane } from '@/shell/email/body-pane';
import { CoolingBanner } from './cooling-banner';
import { AntiPatternList, type AntiPattern, QualityScorecard } from './quality-scorecard';
import { buildAntiPatternPrompt } from './anti-pattern-prompt';

const TYPE_LABEL: Record<string, string> = {
  newsletter: 'Newsletter',
  investor_update: 'Investor update',
};

const CANNED_REASONS = [
  'Claim unverified',
  'Hype / off-brand voice',
  'Off-theme this month',
  'Schedule conflict',
  'Weak / missing CTA',
  'Repeats recent edition',
  'Insufficient content',
];

function formatLagosDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function isCooling(d: EmailDraft, nowMs: number): boolean {
  return !!d.reviewable_after && new Date(d.reviewable_after).getTime() > nowMs;
}

interface QueuePageProps {
  focus?: 'cooling';
  draftId?: string;
}

export function NewsletterQueuePage({ focus, draftId }: QueuePageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(
    newsletterDraftsListQuery({
      statuses: ['draft', 'pending_review', 'approved'],
    }),
  );

  const drafts = data ?? [];
  const nowMs = Date.now();

  const groups = useMemo(() => {
    const cooling: EmailDraft[] = [];
    const ready: EmailDraft[] = [];
    const approved: EmailDraft[] = [];
    for (const d of drafts) {
      if (d.status === 'approved') approved.push(d);
      else if (isCooling(d, nowMs)) cooling.push(d);
      else ready.push(d);
    }
    return { cooling, ready, approved };
  }, [drafts, nowMs]);

  // Auto-select first draft based on focus / draftId / availability.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    if (drafts.length === 0) return;
    initRef.current = true;
    if (draftId && drafts.some((d) => d.id === draftId)) {
      setSelectedId(draftId);
      return;
    }
    if (focus === 'cooling' && groups.cooling[0]) {
      setSelectedId(groups.cooling[0].id);
      return;
    }
    setSelectedId(
      groups.ready[0]?.id ?? groups.cooling[0]?.id ?? groups.approved[0]?.id ?? null,
    );
  }, [drafts, draftId, focus, groups]);

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
      <div
        style={{
          margin: 'var(--space-3)',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          background: 'color-mix(in srgb, var(--danger) 10%, var(--bg-sunken))',
          color: 'var(--danger)',
          fontSize: 'var(--text-body-sm)',
          display: 'flex',
          gap: 8,
        }}
      >
        <AlertCircle aria-hidden style={{ flexShrink: 0, marginTop: 2, width: 14, height: 14 }} />
        <div>
          <p style={{ margin: 0, fontWeight: 500 }}>Failed to load newsletters</p>
          <p style={{ margin: 0, opacity: 0.8, fontSize: 11 }}>{error.message}</p>
        </div>
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <div className="ob-empty" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
        <h3>No newsletter drafts</h3>
        <p>Drafts will appear here when the newsletter pipeline runs.</p>
      </div>
    );
  }

  function selectDraft(id: string) {
    setSelectedId(id);
    navigate({
      to: '/outbox/newsletter/queue',
      search: (prev: Record<string, unknown>) => ({ ...prev, draft: id }),
      replace: true,
    });
  }

  return (
    <div className="nl-split">
      <div className="nl-master">
        <Group label={`Cooling · ${groups.cooling.length}`} draftCount={groups.cooling.length}>
          {groups.cooling.map((d) => (
            <DraftRow
              key={d.id}
              draft={d}
              selected={d.id === selectedId}
              onClick={() => selectDraft(d.id)}
              cooling
            />
          ))}
        </Group>
        <Group label={`Ready to review · ${groups.ready.length}`} draftCount={groups.ready.length}>
          {groups.ready.map((d) => (
            <DraftRow
              key={d.id}
              draft={d}
              selected={d.id === selectedId}
              onClick={() => selectDraft(d.id)}
            />
          ))}
        </Group>
        {groups.approved.length > 0 && (
          <Group label={`Approved · ${groups.approved.length}`} draftCount={groups.approved.length}>
            {groups.approved.map((d) => (
              <DraftRow
                key={d.id}
                draft={d}
                selected={d.id === selectedId}
                onClick={() => selectDraft(d.id)}
              />
            ))}
          </Group>
        )}
      </div>
      <div className="nl-detail">
        {selected ? (
          <DraftDetail
            draft={selected}
            invalidate={() =>
              queryClient.invalidateQueries({ queryKey: queryKeys.newsletters.all })
            }
          />
        ) : (
          <div className="nl-detail-empty">Select a draft to review.</div>
        )}
      </div>
    </div>
  );
}

function Group({
  label,
  draftCount,
  children,
}: {
  label: string;
  draftCount: number;
  children: React.ReactNode;
}) {
  if (draftCount === 0) return null;
  return (
    <>
      <div className="nl-master-group-head">{label}</div>
      {children}
    </>
  );
}

function DraftRow({
  draft,
  selected,
  onClick,
  cooling,
}: {
  draft: EmailDraft;
  selected: boolean;
  onClick: () => void;
  cooling?: boolean;
}) {
  const remaining = draft.reviewable_after
    ? new Date(draft.reviewable_after).getTime() - Date.now()
    : 0;
  const remainMin = Math.ceil(remaining / 60000);
  return (
    <div
      className={`nl-row${selected ? ' is-on' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="nl-row-head">
          <span
            className={`ob-chip ${
              draft.type === 'investor_update' ? 'ob-chip-tint' : 'ob-chip-tint'
            }`}
          >
            {TYPE_LABEL[draft.type] ?? draft.type}
          </span>
          {draft.status === 'approved' && <span className="ob-chip ob-chip-ok">Approved</span>}
        </div>
        <div className="nl-row-subj">{draft.subject}</div>
        {draft.preheader && <div className="nl-row-pre">{draft.preheader}</div>}
      </div>
      <div className="nl-row-meta">
        {cooling && remaining > 0 ? (
          <div className="when cool">
            approve in {remainMin >= 60 ? `${Math.floor(remainMin / 60)}h ${remainMin % 60}m` : `${remainMin}m`}
          </div>
        ) : draft.scheduled_for ? (
          <div className="when">{formatLagosDate(draft.scheduled_for)}</div>
        ) : (
          <div className="when">no schedule</div>
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
  const [subjectAlt, setSubjectAlt] = useState(draft.subject_alt ?? '');
  const [preheader, setPreheader] = useState(draft.preheader ?? '');
  const [body, setBody] = useState(draft.body);
  const [scheduled, setScheduled] = useState(draft.scheduled_for ?? '');
  const [savedToast, setSavedToast] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [fixSeed, setFixSeed] = useState<string | null>(null);

  // Reset edits when the selected draft changes.
  useEffect(() => {
    setSubject(draft.subject);
    setSubjectAlt(draft.subject_alt ?? '');
    setPreheader(draft.preheader ?? '');
    setBody(draft.body);
    setScheduled(draft.scheduled_for ?? '');
    setRejecting(false);
    setRejectionReason('');
  }, [draft.id]);

  const cooling =
    !!draft.reviewable_after && new Date(draft.reviewable_after).getTime() > Date.now();
  const isPending = ['draft', 'pending_review'].includes(draft.status);

  const edited =
    subject !== draft.subject ||
    subjectAlt !== (draft.subject_alt ?? '') ||
    preheader !== (draft.preheader ?? '') ||
    body !== draft.body ||
    scheduled !== (draft.scheduled_for ?? '');

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const { error } = await supabase
        .from('email_drafts')
        .update(updates)
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
    mutationFn: async (updates: Record<string, unknown>) => {
      const { error } = await supabase
        .from('email_drafts')
        .update(updates)
        .eq('id', draft.id);
      if (error) throw error;
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
    saveMutation.isPending || approveMutation.isPending || rejectMutation.isPending;

  function handleSave() {
    saveMutation.mutate({
      subject,
      subject_alt: subjectAlt || null,
      preheader: preheader || null,
      body,
      scheduled_for: scheduled || null,
    });
  }

  function handleReset() {
    setSubject(draft.subject);
    setSubjectAlt(draft.subject_alt ?? '');
    setPreheader(draft.preheader ?? '');
    setBody(draft.body);
    setScheduled(draft.scheduled_for ?? '');
  }

  function handleApprove() {
    approveMutation.mutate({
      status: 'approved',
      approved_at: new Date().toISOString(),
      subject,
      subject_alt: subjectAlt || null,
      preheader: preheader || null,
      body,
      scheduled_for:
        scheduled || getNextSlot(draft.type === 'investor_update' ? 'investor_update' : 'newsletter'),
    });
  }

  function handleSkipMonth() {
    rejectMutation.mutate('Skipped — insufficient content this month');
  }

  function handleConfirmReject() {
    rejectMutation.mutate(rejectionReason || null);
  }

  return (
    <>
      {cooling && draft.reviewable_after && (
        <CoolingBanner
          createdAt={draft.created_at}
          reviewableAfter={draft.reviewable_after}
        />
      )}

      {/* Subject + alt + preheader */}
      <div className="nl-subj-card">
        <div className="nl-subj-row">
          <span className="lbl">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={!isPending}
          />
        </div>
        <div className="nl-subj-row alt">
          <span className="lbl">A/B alt</span>
          <input
            type="text"
            value={subjectAlt}
            onChange={(e) => setSubjectAlt(e.target.value)}
            placeholder="Alternative subject for A/B"
            disabled={!isPending}
          />
        </div>
        <div className="nl-subj-row">
          <span className="lbl">Preheader</span>
          <input
            type="text"
            value={preheader}
            onChange={(e) => setPreheader(e.target.value)}
            placeholder="Preview text in the inbox"
            disabled={!isPending}
          />
        </div>
        <div className="pre-row">
          <span className="ob-chip">
            {draft.delivery_system} · From <strong>{draft.from_name}</strong> &lt;
            {draft.from_email}&gt;
          </span>
          {edited && (
            <span className="ob-chip ob-chip-tint">
              <Pencil aria-hidden /> Edited
            </span>
          )}
          {savedToast && (
            <span className="ob-chip ob-chip-ok">
              <CheckCircle aria-hidden /> Saved
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            subject · {subject.length} chars · alt · {subjectAlt.length} chars · pre ·{' '}
            {preheader.length} chars
          </span>
        </div>
      </div>

      <QualityScorecard draft={draft} />
      <AntiPatternList
        draft={draft}
        onFix={(ap: AntiPattern) =>
          setFixSeed(buildAntiPatternPrompt(ap, body, subject))
        }
      />

      <NewSessionDialog
        open={fixSeed != null}
        onOpenChange={(open) => {
          if (!open) setFixSeed(null);
        }}
        presetPrompt={fixSeed ?? ''}
      />

      {rejecting && (
        <div className="nl-reject">
          <label htmlFor="reject-reason">Why are you rejecting this draft?</label>
          <div className="canned">
            {CANNED_REASONS.map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => setRejectionReason(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="rrow">
            <input
              id="reject-reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Add detail (optional)"
              autoFocus
            />
            <button className="ob-btn" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              className="ob-btn ob-btn-danger-solid"
              onClick={handleConfirmReject}
              disabled={busy}
            >
              Confirm reject
            </button>
          </div>
        </div>
      )}

      {/* Body editor */}
      <div className="nl-body-pane">
        <BodyPane
          body={body}
          format={draft.body_format}
          onChange={setBody}
          disabled={!isPending}
          textareaClassName="nl-body-textarea"
        />
      </div>

      {/* Action footer */}
      <div className="nl-actions">
        <span className="meta">
          {draft.scheduled_for
            ? `scheduled · ${formatLagosDate(draft.scheduled_for)} Lagos · ${draft.delivery_system}`
            : `not scheduled · ${draft.delivery_system}`}
        </span>
        <span className="spacer" />
        <HandoffButtons
          draftId={draft.id}
          draftTitle={subject}
          draftBody={body}
          agentSlug={draft.created_by ?? undefined}
        />
        {isPending && (
          <>
            <button
              type="button"
              className="ob-btn"
              onClick={handleSkipMonth}
              disabled={busy}
              title="Skip this month — not enough content"
            >
              <SkipForward aria-hidden /> Skip month
            </button>
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
                  onClick={handleReset}
                  title="Reset to original"
                >
                  <RotateCcw aria-hidden />
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={handleSave}
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
              className="ob-btn ob-btn-primary"
              onClick={handleApprove}
              disabled={busy || cooling}
              title={
                cooling
                  ? 'Reviewable after cooling period — Approve unlocks then'
                  : 'Approve and schedule for next default slot (Lagos)'
              }
            >
              {approveMutation.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Approve & Schedule
            </button>
          </>
        )}
      </div>
    </>
  );
}
