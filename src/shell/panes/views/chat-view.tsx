import { AlertCircle, Loader2, MessageSquare } from 'lucide-react';
import {
  AdapterSwitcher,
  Composer,
  Thread,
  useEnsureThreadForSession,
} from '@/chat';

interface ChatViewProps {
  sessionId: string;
}

const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ChatView({ sessionId }: ChatViewProps) {
  // Only hydrate when the sessionId looks like a real Claude session UUID.
  // new-tab-menu / command-palette mint placeholder ids like `chat-1234…`
  // that don't map to anything on disk; we render the empty state for those
  // so the user can start a real session via ⌘⇧N.
  const isClaudeSession =
    sessionId.length > 0 && CLAUDE_SESSION_ID_RE.test(sessionId);
  if (!isClaudeSession) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="max-w-sm text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">No session selected</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Open a session from the Sessions sidebar or use{' '}
            <span className="font-mono">⌘⇧N</span> to start a new Claude session.
          </div>
        </div>
      </div>
    );
  }
  return <ChatViewBody sessionId={sessionId} />;
}

function ChatViewBody({ sessionId }: { sessionId: string }) {
  const { threadId, loading, error } = useEnsureThreadForSession(sessionId);
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          <span className="font-mono">{sessionId.slice(0, 8)}…</span>
        </div>
        <AdapterSwitcher />
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className="m-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <Thread threadId={threadId} className="flex-1" />
          <Composer threadId={threadId} />
        </>
      )}
    </div>
  );
}
