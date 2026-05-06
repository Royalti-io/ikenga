import { useMemo } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';

import { useShellStore } from '@/lib/shell/shell-store';
import { claudeConfigQueryOptions } from '@/lib/queries/claude-config';
import {
  detectAgentSlug,
  sessionsListQueryOptions,
} from '@/lib/queries/sessions';
import { useLiveSessions } from '@/lib/queries/live-sessions';
import { cn } from '@/components/ui/utils';

import '../sessions.css';

export const Route = createFileRoute('/sessions/by-agent/')({
  component: ByAgentIndex,
});

function ByAgentIndex() {
  const projectRoots = useShellStore((s) => s.claudeProjectRoots);
  const agentsQuery = useQuery(claudeConfigQueryOptions(projectRoots));
  const sessionsQuery = useQuery(sessionsListQueryOptions(null));
  const liveSessionsObj = useLiveSessions((s) => s.sessions);
  const liveIds = useMemo(
    () => new Set(Object.keys(liveSessionsObj)),
    [liveSessionsObj],
  );

  const agents = agentsQuery.data?.agents ?? [];

  const sessionsByAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessionsQuery.data ?? []) {
      const a = detectAgentSlug(s);
      if (!a) continue;
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return m;
  }, [sessionsQuery.data]);

  const liveByAgent = useMemo(() => {
    const m = new Set<string>();
    for (const s of sessionsQuery.data ?? []) {
      if (liveIds.has(s.sessionId)) {
        const a = detectAgentSlug(s);
        if (a) m.add(a);
      }
    }
    return m;
  }, [sessionsQuery.data, liveIds]);

  return (
    <div className="ses-agents-split">
      <div className="ses-agents-list">
        <div className="ses-list-head" style={{ padding: 'var(--space-3) var(--space-4)' }}>
          <div>
            <h2 style={{ fontSize: 'var(--text-h4)' }}>
              <Bot className="h-mark" />
              Agents
              <span className="count">({agents.length})</span>
            </h2>
          </div>
        </div>
        {agentsQuery.isLoading && (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        )}
        {agentsQuery.error && (
          <div className="p-4 text-sm text-destructive">{String(agentsQuery.error)}</div>
        )}
        {agents.map((a) => {
          const count = sessionsByAgent.get(a.name) ?? 0;
          const isLive = liveByAgent.has(a.name);
          return (
            <Link
              key={`${a.scope}:${a.name}`}
              to="/sessions/by-agent/$agent"
              params={{ agent: a.name }}
              className={cn('ses-agent-row')}
              activeProps={{ className: 'ses-agent-row is-on' }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="name">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.name}
                  </span>
                  {isLive && (
                    <span className="live-badge">
                      <span className="live-dot" />
                      live
                    </span>
                  )}
                </div>
                {a.model && <div className="model">{a.model}</div>}
              </div>
              <span className="ct">{count > 0 ? count : ''}</span>
            </Link>
          );
        })}
        {!agentsQuery.isLoading && agents.length === 0 && (
          <div className="px-4 py-4 text-xs text-muted-foreground">
            No agents discovered. Configure project roots in Settings.
          </div>
        )}
      </div>
      <div style={{ background: 'var(--border-soft)' }} />
      <div className="ses-agents-detail">
        <div className="ses-empty">Select an agent to see its session history.</div>
      </div>
    </div>
  );
}
