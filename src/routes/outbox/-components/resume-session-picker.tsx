import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sessionsListQueryOptions, type SessionSummary } from '@/lib/queries/sessions';
import { useLiveSessions } from '@/lib/queries/live-sessions';

export interface ResumeSessionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Origin draft id, used to filter/seed. */
  draftId?: string;
  /** Display title for the modal subtitle (e.g. email subject). */
  draftTitle?: string;
  /** Project directory to filter sessions to. Defaults to all. */
  projectDir?: string;
  /** Agent slug hint (PA / CMO / CBO …) used in copy only. */
  agentSlug?: string;
  /** Called when user picks "Start fresh" — opens NewSessionDialog. */
  onStartFresh?: () => void;
}

function shortId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 5)}…${id.slice(-3)}`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const delta = Date.now() - t;
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ResumeSessionPickerModal({
  open,
  onOpenChange,
  draftId,
  draftTitle,
  projectDir,
  agentSlug,
  onStartFresh,
}: ResumeSessionPickerProps) {
  const navigate = useNavigate();
  const { data: sessions, isLoading } = useQuery(
    sessionsListQueryOptions(projectDir ?? null, 20),
  );
  const liveSessionsMap = useLiveSessions((s) => s.sessions);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setPicked(null);
  }, [open]);

  const { live, recent } = useMemo(() => {
    const list = sessions ?? [];
    const live: SessionSummary[] = [];
    const recent: SessionSummary[] = [];
    for (const s of list) {
      if (liveSessionsMap[s.sessionId]) live.push(s);
      else recent.push(s);
    }
    return { live, recent: recent.slice(0, 6) };
  }, [sessions, liveSessionsMap]);

  function handleResume() {
    if (!picked) return;
    onOpenChange(false);
    // TODO: when handoff lands, prefill the session composer with
    //  "Rewrite this draft: …" using draftId. For now just navigate.
    navigate({ to: '/sessions/$sessionId', params: { sessionId: picked } });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Continue a Claude session</DialogTitle>
          <DialogDescription>
            {draftTitle ? <strong>{draftTitle}</strong> : 'Draft'}
            {agentSlug ? ` · drafted by ${agentSlug}` : ''}
            {draftId ? ` · ${shortId(draftId)}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="ob-pick-list" style={{ maxHeight: 380, overflow: 'auto' }}>
          {isLoading && (
            <div className="ob-loading">Loading sessions…</div>
          )}

          {!isLoading && live.length > 0 && (
            <>
              <div className="ob-pick-section">Live · {live.length}</div>
              {live.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className={`ob-pick-row${picked === s.sessionId ? ' is-on' : ''}`}
                  onClick={() => setPicked(s.sessionId)}
                >
                  <span className="ob-pick-radio" />
                  <span>
                    <span className="ob-pick-title">
                      <span className="ob-pulse" />
                      {s.title ?? `Session ${shortId(s.sessionId)}`}
                    </span>
                    <span className="ob-pick-sub">
                      {s.messageCount} messages · {relativeTime(s.lastMessageAt)}
                    </span>
                  </span>
                  <span className="ob-pick-meta">
                    <div>{shortId(s.sessionId)}</div>
                    <div>{s.projectDir.split('/').slice(-1)[0]}</div>
                  </span>
                </button>
              ))}
            </>
          )}

          {!isLoading && recent.length > 0 && (
            <>
              <div className="ob-pick-section">
                Recent · {projectDir ? 'same project' : 'all projects'} · {recent.length}
              </div>
              {recent.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className={`ob-pick-row${picked === s.sessionId ? ' is-on' : ''}`}
                  onClick={() => setPicked(s.sessionId)}
                >
                  <span className="ob-pick-radio" />
                  <span>
                    <span className="ob-pick-title">
                      {s.title ?? `Session ${shortId(s.sessionId)}`}
                    </span>
                    <span className="ob-pick-sub">
                      {s.messageCount} messages · {relativeTime(s.lastMessageAt)}
                    </span>
                  </span>
                  <span className="ob-pick-meta">
                    <div>{shortId(s.sessionId)}</div>
                    <div>{relativeTime(s.lastMessageAt)}</div>
                  </span>
                </button>
              ))}
            </>
          )}

          {!isLoading && live.length === 0 && recent.length === 0 && (
            <div className="ob-empty" style={{ padding: 'var(--space-6)' }}>
              <p>No prior sessions found. Start a fresh one below.</p>
            </div>
          )}

          <button
            type="button"
            className="ob-pick-row is-new"
            onClick={() => {
              onOpenChange(false);
              onStartFresh?.();
            }}
            style={{ marginTop: 'var(--space-3)' }}
          >
            <span className="ob-pick-radio" />
            <span>
              <span className="ob-pick-title">+ Start a fresh session instead</span>
              <span className="ob-pick-sub">
                Opens NewSessionDialog with this draft as preset prompt.
              </span>
            </span>
            <span className="ob-pick-meta">⌘⇧N</span>
          </button>
        </div>

        <DialogFooter>
          <span
            style={{
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--fg-faint)',
              letterSpacing: '.04em',
            }}
          >
            Resumed sessions inherit context — no need to re-paste the draft.
          </span>
          <button
            type="button"
            className="ob-btn"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ob-btn ob-btn-primary"
            onClick={handleResume}
            disabled={!picked}
          >
            Resume &amp; open
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
