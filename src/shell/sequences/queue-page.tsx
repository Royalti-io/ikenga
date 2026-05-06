import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Send, XCircle } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import {
  emailSequencesListQuery,
  sequenceStepsQuery,
  type EmailSequence,
  type SequenceStepDraft,
} from '@/lib/queries/email-sequences';
import { HandoffButtons } from '@/routes/outbox/-components/handoff-buttons';

const REJECT_REASONS = [
  'Segment is wrong',
  'Tone is off across steps',
  'Cadence is wrong',
  'Rewrite from scratch',
  'Duplicate of existing sequence',
];

const DELIVERY_LABEL: Record<string, string> = {
  listmonk: 'Listmonk',
  resend: 'Resend',
  smtp: 'SMTP',
};

export function SequencesQueuePage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery(emailSequencesListQuery());
  const sequences = data ?? [];

  const groups = useMemo(() => {
    const inReview: EmailSequence[] = [];
    const drafts: EmailSequence[] = [];
    const running: EmailSequence[] = [];
    for (const s of sequences) {
      if (s.status === 'review') inReview.push(s);
      else if (s.status === 'draft') drafts.push(s);
      else running.push(s);
    }
    return { inReview, drafts, running };
  }, [sequences]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && sequences.some((s) => s.id === selectedId)) return;
    const first =
      groups.inReview[0] ?? groups.drafts[0] ?? groups.running[0] ?? null;
    setSelectedId(first?.id ?? null);
  }, [sequences, selectedId, groups]);

  const selected = selectedId
    ? sequences.find((s) => s.id === selectedId) ?? null
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
        Failed to load sequences: {error.message}
      </div>
    );
  }
  if (sequences.length === 0) {
    return (
      <div className="ob-empty" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
        <h3>No sequences yet</h3>
        <p>Sequences appear here when vp-sales-agent or you draft one.</p>
      </div>
    );
  }

  function selectSeq(id: string) {
    setSelectedId(id);
  }

  return (
    <div className="nl-split sq-split">
      <div className="nl-master">
        <SeqGroup label={`In review · ${groups.inReview.length}`} count={groups.inReview.length}>
          {groups.inReview.map((s) => (
            <SeqRow
              key={s.id}
              seq={s}
              selected={s.id === selectedId}
              onClick={() => selectSeq(s.id)}
            />
          ))}
        </SeqGroup>
        {groups.drafts.length > 0 && (
          <SeqGroup label={`Draft · ${groups.drafts.length}`} count={groups.drafts.length}>
            {groups.drafts.map((s) => (
              <SeqRow
                key={s.id}
                seq={s}
                selected={s.id === selectedId}
                onClick={() => selectSeq(s.id)}
              />
            ))}
          </SeqGroup>
        )}
        {groups.running.length > 0 && (
          <SeqGroup label={`Running · ${groups.running.length}`} count={groups.running.length}>
            {groups.running.map((s) => (
              <SeqRow
                key={s.id}
                seq={s}
                selected={s.id === selectedId}
                onClick={() => selectSeq(s.id)}
              />
            ))}
          </SeqGroup>
        )}
      </div>
      <div className="nl-detail">
        {selected ? (
          <SeqDetail
            sequence={selected}
            invalidate={() =>
              queryClient.invalidateQueries({ queryKey: ['email_sequences'] })
            }
          />
        ) : (
          <div className="nl-detail-empty">Select a sequence to review.</div>
        )}
      </div>
    </div>
  );
}

function SeqGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <>
      <div className="nl-master-group-head">{label}</div>
      {children}
    </>
  );
}

function SeqRow({
  seq,
  selected,
  onClick,
}: {
  seq: EmailSequence;
  selected: boolean;
  onClick: () => void;
}) {
  const totalDays =
    Array.isArray(seq.step_delays) && seq.step_delays.length > 0
      ? seq.step_delays.reduce((a, b) => a + (Number(b) || 0), 0)
      : 0;
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
          <span className="ob-chip ob-chip-tint">{seq.delivery_system}</span>
          <span className="ob-chip">{seq.status}</span>
          {seq.segment && <span className="ob-chip">{seq.segment}</span>}
        </div>
        <div className="nl-row-subj">{seq.name}</div>
        {seq.description && <div className="nl-row-pre">{seq.description}</div>}
        <div className="sq-row-progress" aria-label={`${seq.total_steps} steps`}>
          {Array.from({ length: seq.total_steps }).map((_, i) => (
            <span key={i} className="sq-row-step is-active" />
          ))}
        </div>
      </div>
      <div className="nl-row-meta">
        <div className="when">{seq.total_steps} steps</div>
        <div className="when">{totalDays}d total</div>
      </div>
    </div>
  );
}

function SeqDetail({
  sequence,
  invalidate,
}: {
  sequence: EmailSequence;
  invalidate: () => void;
}) {
  const stepsQuery = useQuery(sequenceStepsQuery(sequence.id));
  const steps = stepsQuery.data ?? [];
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  // Reset reject panel when switching sequences
  useEffect(() => {
    setRejecting(false);
    setRejectionReason('');
  }, [sequence.id]);

  const isPending = sequence.status === 'draft' || sequence.status === 'review';

  const approveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('email_sequences')
        .update({
          status: 'active',
          approved_at: new Date().toISOString(),
        })
        .eq('id', sequence.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: async (reason: string | null) => {
      // email_sequences has no 'rejected' status — use 'completed' with a
      // rejection note in metadata (closest legal terminal state).
      const { error } = await supabase
        .from('email_sequences')
        .update({
          status: 'completed',
          metadata: { rejected: true, rejection_reason: reason },
        })
        .eq('id', sequence.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setRejecting(false);
      setRejectionReason('');
      invalidate();
    },
  });

  const totalDays = Array.isArray(sequence.step_delays)
    ? sequence.step_delays.reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const busy = approveMutation.isPending || rejectMutation.isPending;

  // Build a seed prompt that includes the whole sequence (steps + delays).
  const seedPrompt = buildSequenceSeed(sequence, steps);

  return (
    <>
      <div className="sq-detail-head">
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
          <span className="ob-chip ob-chip-tint">{DELIVERY_LABEL[sequence.delivery_system] ?? sequence.delivery_system}</span>
          <span className="ob-chip">{sequence.created_by}</span>
          <span className="ob-chip">{sequence.status}</span>
        </div>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, lineHeight: 1.25, margin: 0 }}>
          {sequence.name}
        </h2>
        {sequence.description && (
          <p style={{
            fontSize: 'var(--text-body-sm)', color: 'var(--fg-muted)',
            margin: 'var(--space-1) 0 0', lineHeight: 1.55,
          }}>
            {sequence.description}
          </p>
        )}
        <div className="sq-detail-meta">
          {sequence.segment && <span><b>Segment</b> {sequence.segment}</span>}
          <span><b>Delivery</b> {DELIVERY_LABEL[sequence.delivery_system] ?? sequence.delivery_system}</span>
          <span><b>Total steps</b> {sequence.total_steps}</span>
          <span><b>Total length</b> {totalDays} days</span>
        </div>
      </div>

      <div className="step-rail">
        {stepsQuery.isLoading && (
          <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--fg-muted)' }}>
            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} aria-hidden />
          </div>
        )}
        {!stepsQuery.isLoading && steps.length === 0 && (
          <div className="ob-empty" style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
            <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--fg-muted)' }}>
              No step drafts yet. Steps come from email_drafts rows joined by sequence_id +
              sequence_step.
            </p>
          </div>
        )}
        {steps.map((step, idx) => {
          const delay = sequence.step_delays?.[idx] ?? 0;
          const cumulative = (sequence.step_delays ?? [])
            .slice(0, idx + 1)
            .reduce((a, b) => a + (Number(b) || 0), 0);
          const isCurrent = step.status === 'pending_review' || step.status === 'draft';
          const isDone = step.status === 'sent' || step.status === 'sending';
          return (
            <div key={step.id}>
              {idx > 0 && (
                <div className="step-delay">
                  +{delay} day{delay === 1 ? '' : 's'}
                </div>
              )}
              <div
                className={`step-card${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}`}
              >
                <div className="step-card-head">
                  <span className="step-num">{step.sequence_step}</span>
                  <span className="step-subj">{step.subject || '— no subject —'}</span>
                  <span className="ob-chip" style={{ marginLeft: 'auto' }}>
                    day {cumulative}
                  </span>
                </div>
                <div className="step-card-meta">
                  <span>{step.delivery_system}</span>
                  <span>{step.status}</span>
                  <span>~ {step.body.length} chars</span>
                </div>
                <div className="step-card-body">
                  {step.body.slice(0, 280)}
                  {step.body.length > 280 ? '…' : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {rejecting && (
        <div className="nl-reject">
          <label htmlFor="seq-reject-reason">Why are you rejecting this sequence?</label>
          <div className="canned">
            {REJECT_REASONS.map((r) => (
              <button type="button" key={r} onClick={() => setRejectionReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <div className="rrow">
            <input
              id="seq-reject-reason"
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
              onClick={() => rejectMutation.mutate(rejectionReason || null)}
              disabled={busy}
            >
              Confirm reject
            </button>
          </div>
        </div>
      )}

      <div className="nl-actions">
        <span className="meta">
          {isPending
            ? `enrol on approve · segment: ${sequence.segment ?? 'unset'}`
            : `status · ${sequence.status}`}
        </span>
        <span className="spacer" />
        <HandoffButtons
          draftId={sequence.id}
          draftTitle={`Sequence · ${sequence.name}`}
          draftBody={seedPrompt}
          agentSlug={sequence.created_by}
        />
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
            <button
              type="button"
              className="ob-btn ob-btn-primary"
              onClick={() => approveMutation.mutate()}
              disabled={busy}
              title="Approve & activate — flips status to active"
            >
              {approveMutation.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Approve & activate
            </button>
          </>
        )}
      </div>
    </>
  );
}

function buildSequenceSeed(
  sequence: EmailSequence,
  steps: SequenceStepDraft[],
): string {
  if (steps.length === 0) return '';
  const lines = [
    `Sequence: ${sequence.name}${sequence.segment ? ` · ${sequence.segment}` : ''}`,
    `Steps: ${sequence.total_steps} · Delivery: ${sequence.delivery_system}`,
    '',
  ];
  let cumulative = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const delay = sequence.step_delays?.[i] ?? 0;
    cumulative += Number(delay) || 0;
    lines.push(`— Step ${step.sequence_step} · day ${cumulative} —`);
    lines.push(`Subject: ${step.subject}`);
    lines.push(step.body);
    lines.push('');
  }
  return lines.join('\n');
}
