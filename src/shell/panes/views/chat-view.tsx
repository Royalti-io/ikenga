import { AlertCircle, Loader2, MessageSquare } from 'lucide-react';
import {
  AdapterSwitcher,
  Composer,
  Thread,
  useThread,
} from '@/chat';

interface ChatViewProps {
  /** Stable thread id (frontend-minted uuid). For back-compat with v1
   *  pane-view shapes, the prop is still called `sessionId`. */
  sessionId: string;
}

export function ChatView({ sessionId }: ChatViewProps) {
  if (!sessionId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="max-w-sm text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">No chat selected</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Open a chat from the dock + menu or use <span className="font-mono">⌘⇧N</span>.
          </div>
        </div>
      </div>
    );
  }
  return <ChatViewBody threadId={sessionId} />;
}

function ChatViewBody({ threadId }: { threadId: string }) {
  const { loading, error } = useThread(threadId);
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          <span className="font-mono">{threadId.slice(0, 8)}…</span>
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
