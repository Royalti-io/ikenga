import { useEffect, useMemo } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  MessageSquare,
  Terminal,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { cn } from '@/components/ui/utils';
import {
  detectAgentSlug,
  sessionsListQueryOptions,
} from '@/lib/queries/sessions';

import '../sessions.css';
import { useLiveSessions } from '@/lib/queries/live-sessions';
import { claudeChatKill } from '@/lib/tauri-cmd';
import {
  AdapterSwitcher,
  Composer,
  Thread,
  useChatStore,
  useEnsureThreadForSession,
} from '@/chat';
import { LiveTerminal } from '@/shell/sessions/live-terminal';

function shortPath(p: string): string {
  if (!p) return '—';
  const home = '/home/nedjamez';
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function SessionDetailPage() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const live = useLiveSessions((s) => s.get(sessionId));
  const removeLive = useLiveSessions((s) => s.remove);
  const aliasLive = useLiveSessions((s) => s.alias);

  // Phase 5: bind this route's claudeSessionId to a chat thread. The hook
  // hydrates the store from JSONL + subscribes to live events while the
  // route is mounted.
  const { threadId, loading, error } = useEnsureThreadForSession(sessionId);
  const eventsLen = useChatStore(
    (s) => (threadId ? s.threads[threadId]?.events.length ?? 0 : 0),
  );

  // Resolve placeholder URLs (`/sessions/pending-<uuid>`) once the parser
  // sees the first `system:init` event and reports the real session id.
  // Without this, the header heading and the URL stay stuck on the
  // placeholder even after Claude responds.
  const resolvedSessionId = useChatStore(
    (s) => (threadId ? s.threads[threadId]?.thread.claudeSessionId ?? null : null),
  );
  useEffect(() => {
    if (
      sessionId.startsWith('pending-') &&
      resolvedSessionId &&
      resolvedSessionId !== sessionId
    ) {
      // Promote the live-session entry under the real id so the new route's
      // detail page can pick it up immediately.
      aliasLive(sessionId, resolvedSessionId);
      navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: resolvedSessionId },
        replace: true,
      });
    }
  }, [sessionId, resolvedSessionId, aliasLive, navigate]);

  // Cheap header info pulled from the list query (already cached if user came
  // from /sessions). Falls back gracefully when accessed via deep-link.
  const { data: list } = useQuery(sessionsListQueryOptions(null));
  const summary = useMemo(
    () => list?.find((s) => s.sessionId === sessionId),
    [list, sessionId],
  );

  function handleKillLive() {
    if (!live) return;
    // Streaming children are real OS processes — kill the backend before we
    // drop the UI handle, otherwise they leak.
    if (live.kind === 'streaming') {
      void claudeChatKill(sessionId).catch((e) =>
        console.warn('claudeChatKill detach:', e),
      );
    }
    removeLive(sessionId);
  }

  const agent = summary ? detectAgentSlug(summary) : null;
  const title = summary?.title ?? sessionId;

  return (
    <div className="flex h-full flex-col">
      <div className="ses-det-head">
        <Link to="/sessions" className="ses-back-link">
          <ArrowLeft />
          All sessions
        </Link>
        <div className="ses-det-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ses-det-titlewrap">
              <Terminal style={{ width: 18, height: 18, color: 'var(--fg-muted)' }} />
              <h3 className="ses-det-title" title={title}>
                {title}
              </h3>
              {live && (
                <span className="live-badge">
                  <span className="live-dot" />
                  Live{live.kind ? ` · ${live.kind}` : ''}
                </span>
              )}
              {agent && (
                <span className="agent-badge" style={{ marginTop: 0 }}>
                  <span className="dot" />
                  {agent}
                </span>
              )}
            </div>
            <div className="ses-det-meta">
              {summary?.projectDir && <code>{shortPath(summary.projectDir)}</code>}
              {summary?.model && (
                <span className="model-badge">
                  {summary.model.replace('claude-', '')}
                </span>
              )}
              {summary?.lastMessageAt && (
                <>
                  <span className="sep">·</span>
                  <span>
                    last activity {new Date(summary.lastMessageAt).toLocaleString()}
                  </span>
                </>
              )}
              <span className="sep">·</span>
              <span className="id">{sessionId.slice(0, 8)}…{sessionId.slice(-4)}</span>
            </div>
          </div>
          <div className="ses-det-actions">
            <AdapterSwitcher />
            {live && (
              <button
                type="button"
                onClick={handleKillLive}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-accent"
              >
                Detach
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="chat" className="flex h-full flex-col">
          <TabsList className="mx-4 mt-2 self-start">
            <TabsTrigger value="chat" className="gap-1.5">
              <MessageSquare className="h-3 w-3" />
              Chat
              {live && eventsLen > 0 && (
                <Badge
                  variant="outline"
                  className="ml-1 border-emerald-200 bg-emerald-50 px-1 text-[9px] tabular-nums"
                >
                  {eventsLen}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="terminal"
              disabled={!live || !live.ptyId}
              className="gap-1.5"
              title={
                live?.ptyId
                  ? 'PTY view'
                  : live
                  ? 'Streaming session has no terminal'
                  : 'Resume the session to attach a terminal'
              }
            >
              <Terminal className="h-3 w-3" />
              Terminal
              {live?.ptyId && (
                <span
                  className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 text-[9px] font-medium uppercase tracking-wide"
                  style={{
                    color: 'var(--live, #4ade80)',
                    background:
                      'color-mix(in srgb, var(--live, #4ade80) 18%, transparent)',
                    border:
                      '1px solid color-mix(in srgb, var(--live, #4ade80) 35%, transparent)',
                  }}
                >
                  live
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="chat"
            className={cn('mt-2 flex flex-1 flex-col overflow-hidden')}
          >
            {loading && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading session events…
              </div>
            )}
            {error && (
              <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Failed to load session</p>
                  <p className="text-xs opacity-80">{error}</p>
                </div>
              </div>
            )}
            {!loading && !error && (
              <>
                <Thread threadId={threadId} className="flex-1" />
                <Composer threadId={threadId} />
              </>
            )}
          </TabsContent>

          <TabsContent value="terminal" className="mt-2 flex-1 overflow-hidden">
            {live?.ptyId ? (
              <LiveTerminal ptyId={live.ptyId} />
            ) : live ? (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                This is a streaming chat session — no terminal available.
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                Resume the session to open a terminal view.
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/sessions/$sessionId/')({
  component: SessionDetailPage,
});
