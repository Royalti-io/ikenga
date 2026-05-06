import { useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2, MessageSquare, Plus, Search, Terminal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import {
  detectAgentSlug,
  sessionsListQueryOptions,
  type SessionSummary,
} from '@/lib/queries/sessions';
import { useLiveSessions } from '@/lib/queries/live-sessions';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';

import './sessions.css';

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

const PAGE_SIZE = 20;

function SessionRow({
  session,
  isLive,
  liveKind,
}: {
  session: SessionSummary;
  isLive: boolean;
  liveKind?: 'pty' | 'streaming';
}) {
  const navigate = useNavigate();
  const agent = detectAgentSlug(session);
  const hasTitle = !!session.title && session.title.trim().length > 0;
  const fallback = `${session.sessionId.slice(0, 8)}…${session.sessionId.slice(-4)}`;

  function handleRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('a')) return;
    navigate({ to: '/sessions/$sessionId', params: { sessionId: session.sessionId } });
  }

  return (
    <tr onClick={handleRowClick} className={cn(isLive && 'is-live')}>
      <td>
        <div className="title-cell">
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.sessionId }}
            className="truncate"
            title={hasTitle ? session.title! : `Session ${session.sessionId}`}
            style={{ color: 'var(--fg)', textDecoration: 'none' }}
          >
            {hasTitle ? (
              session.title
            ) : (
              <span className="session-id-fb">{fallback}</span>
            )}
          </Link>
        </div>
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {agent && (
            <span className="agent-badge">
              <span className="dot" />
              {agent}
            </span>
          )}
          {isLive && (
            <span className="live-badge" style={{ marginTop: 4 }}>
              <span className="live-dot" />
              Live{liveKind ? ` · ${liveKind}` : ''}
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="muted" title={session.projectDir}>
          {shortPath(session.projectDir)}
        </div>
      </td>
      <td>
        {session.model ? (
          <span className="model-badge">{session.model.replace('claude-', '')}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num muted">{session.messageCount}</td>
      <td className="muted">{formatRelative(session.lastMessageAt ?? session.startedAt)}</td>
    </tr>
  );
}

function SessionsPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/sessions/' }) as { new?: string };
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [searchTerm, setSearch] = useState('');
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const liveSessions = useLiveSessions((s) => s.sessions);

  useEffect(() => {
    if (search.new === '1' && !newDialogOpen) {
      setNewDialogOpen(true);
      navigate({ to: '/sessions', search: {}, replace: true });
    }
  }, [search.new, newDialogOpen, navigate]);

  const { data, isLoading, isFetching, error } = useQuery(
    sessionsListQueryOptions(null, limit),
  );
  const hasMore = !!data && data.length >= limit;

  const projects = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const s of data) {
      if (s.projectDir) set.add(s.projectDir);
    }
    return Array.from(set).sort();
  }, [data]);

  const agents = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const s of data) {
      const a = detectAgentSlug(s);
      if (a) set.add(a);
    }
    return Array.from(set).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as SessionSummary[];
    const q = searchTerm.trim().toLowerCase();
    return data.filter((s) => {
      if (projectFilter && s.projectDir !== projectFilter) return false;
      if (agentFilter) {
        const a = detectAgentSlug(s);
        if (agentFilter === 'unassigned' ? a !== null : a !== agentFilter) return false;
      }
      if (!q) return true;
      return (
        (s.title?.toLowerCase().includes(q) ?? false) ||
        s.sessionId.toLowerCase().includes(q) ||
        s.projectDir.toLowerCase().includes(q)
      );
    });
  }, [data, projectFilter, agentFilter, searchTerm]);

  return (
    <div className="flex h-full flex-col p-5">
      <div className="ses-frame flex-1">
        <div className="ses-list-head">
          <div>
            <h2>
              <Terminal className="h-mark" />
              Sessions
              {data && (
                <span className="count">
                  ({filtered.length}
                  {filtered.length !== data.length && ` of ${data.length}`})
                </span>
              )}
            </h2>
            <div className="sub">
              Claude Code sessions across all projects under
              <code>~/.claude/projects</code>. Click a row to inspect; resume to continue.
            </div>
          </div>
          <Button size="sm" onClick={() => setNewDialogOpen(true)}>
            <Plus className="h-3 w-3" />
            New session
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, opacity: 0.7, marginLeft: 6 }}>
              ⌘⇧N
            </span>
          </Button>
        </div>

        <div className="ses-filterbar">
          <div className="input-search-wrap">
            <Search />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, session id, project…"
            />
          </div>
          <span className="label">Project</span>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {shortPath(p)}
              </option>
            ))}
          </select>
          <span className="label">Agent</span>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            <option value="unassigned">(unassigned)</option>
          </select>
          <div className="spacer" />
          <span className="label">
            {filtered.length} of {data?.length ?? 0}
          </span>
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
                <p className="font-medium">Failed to list sessions</p>
                <p className="text-xs opacity-80">{error.message}</p>
              </div>
            </div>
          )}
          {data && filtered.length === 0 && !isLoading && (
            <div className="m-5 flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              <MessageSquare className="mr-2 h-4 w-4" />
              No sessions match.
            </div>
          )}
          {filtered.length > 0 && (
            <>
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
                        <SessionRow
                          key={s.sessionId}
                          session={s}
                          isLive={!!live}
                          liveKind={live?.kind}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-3) 0 var(--space-5)' }}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLimit((l) => l + PAGE_SIZE)}
                    disabled={isFetching}
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      `Load ${PAGE_SIZE} more`
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <NewSessionDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        defaultProjects={projects}
      />
    </div>
  );
}

export const Route = createFileRoute('/sessions/')({
  component: SessionsPage,
});
