import { useMemo } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Loader2, MessageSquare, Terminal } from 'lucide-react';

import {
  detectAgentSlug,
  sessionsListQueryOptions,
  type SessionSummary,
} from '@/lib/queries/sessions';
import { useLiveSessions } from '@/lib/queries/live-sessions';
import { cn } from '@/components/ui/utils';

import '../sessions.css';

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const ms = Date.now() - ts;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortPath(p: string): string {
  if (!p) return '—';
  const home = '/home/nedjamez';
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function AgentSessionsPage() {
  const { agent } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(sessionsListQueryOptions(null));
  const liveSessions = useLiveSessions((s) => s.sessions);

  const filtered = useMemo(() => {
    if (!data) return [] as SessionSummary[];
    if (agent === 'unassigned') {
      return data.filter((s) => detectAgentSlug(s) === null);
    }
    return data.filter((s) => detectAgentSlug(s) === agent);
  }, [data, agent]);

  return (
    <div className="flex h-full flex-col p-5">
      <div className="ses-frame flex-1">
        <div className="ses-det-head">
          <Link to="/sessions/by-agent" className="ses-back-link">
            <ArrowLeft />
            All agents
          </Link>
          <div className="ses-det-row">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ses-det-titlewrap">
                <Terminal style={{ width: 18, height: 18, color: 'var(--fg-muted)' }} />
                <h3 className="ses-det-title" title={agent}>
                  {agent === 'unassigned' ? 'Unassigned sessions' : `${agent} sessions`}
                </h3>
                {data && (
                  <span style={{ fontSize: 'var(--text-body-sm)', color: 'var(--fg-muted)' }}>
                    ({filtered.length})
                  </span>
                )}
              </div>
              <div className="ses-det-meta">
                <span>
                  Sessions whose first prompt invokes{' '}
                  {agent === 'unassigned' ? 'no recognized agent' : agent}.
                </span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {isLoading && (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning sessions…
            </div>
          )}
          {error instanceof Error && (
            <div className="m-5 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Failed to load sessions</p>
                <p className="text-xs opacity-80">{error.message}</p>
              </div>
            </div>
          )}
          {data && filtered.length === 0 && !isLoading && (
            <div className="m-5 flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              <MessageSquare className="mr-2 h-4 w-4" />
              No sessions for this agent.
            </div>
          )}
          {filtered.length > 0 && (
            <div className="ses-table-wrap">
              <table className="ses-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th style={{ width: 240 }}>Project</th>
                    <th style={{ width: 120 }}>Model</th>
                    <th className="num" style={{ width: 70 }}>
                      # msgs
                    </th>
                    <th style={{ width: 140 }}>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const live = liveSessions[s.sessionId];
                    return (
                      <tr
                        key={s.sessionId}
                        className={cn(live && 'is-live')}
                        onClick={() =>
                          navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: s.sessionId },
                          })
                        }
                      >
                        <td>
                          <div className="title-cell">
                            <span className="truncate" title={s.title ?? s.sessionId}>
                              {s.title ?? (
                                <span className="session-id-fb">
                                  {s.sessionId.slice(0, 8)}…{s.sessionId.slice(-4)}
                                </span>
                              )}
                            </span>
                          </div>
                          {live && (
                            <span className="live-badge" style={{ marginTop: 4 }}>
                              <span className="live-dot" />
                              Live{live.kind ? ` · ${live.kind}` : ''}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="muted">{shortPath(s.projectDir)}</div>
                        </td>
                        <td>
                          {s.model ? (
                            <span className="model-badge">
                              {s.model.replace('claude-', '')}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num muted">{s.messageCount}</td>
                        <td className="muted">
                          {formatRelative(s.lastMessageAt ?? s.startedAt)}
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
    </div>
  );
}

export const Route = createFileRoute('/sessions/by-agent/$agent')({
  component: AgentSessionsPage,
});
