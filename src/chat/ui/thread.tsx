/**
 * Thread — store-backed event list. Uses AI Elements <Conversation> for
 * smart sticky-scroll, <Message> for user/assistant chat exchanges, and
 * compact <Row>s for system/diagnostic events (session_init, done, hooks,
 * rate_limit, etc). Tool calls render through <ToolCallCard>.
 */

import { useMemo } from 'react';
import {
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  CircleAlert,
  Loader2,
  MessageCircle,
  User,
} from 'lucide-react';
import type { ChatEvent } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  buildRenderItems,
  selectDebugEvents,
  useChatStore,
  type RenderItem,
} from '../store';
import { ToolCallCard } from './tool-call-card';
import { ArtifactPill } from './artifact-pill';
import { Markdown } from '@/components/markdown';

interface ThreadProps {
  threadId: string | null;
  className?: string;
  /** Kept for API compat; auto-scroll is now handled by Conversation. */
  autoScroll?: boolean;
}

export function Thread({ threadId, className }: ThreadProps) {
  const state = useChatStore((s) => (threadId ? s.threads[threadId] ?? null : null));
  const cwd = state?.thread.cwd ?? undefined;
  const includeDebug = import.meta.env.DEV;
  const items = useMemo(
    () => (state ? buildRenderItems(state.events, false) : []),
    [state?.events],
  );
  const debugEvents = useMemo(
    () => (includeDebug && state ? selectDebugEvents(state.events) : []),
    [state?.events, includeDebug],
  );

  if (!threadId || !state) {
    return (
      <div className={cn('flex h-full items-center justify-center text-sm text-muted-foreground', className)}>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading thread…
      </div>
    );
  }

  return (
    <Conversation className={cn('h-full', className)}>
      <ConversationContent className="flex-col gap-2 p-0">
        {items.length === 0 ? (
          <ConversationEmptyState
            title="No messages yet"
            description="Send a prompt to start the conversation."
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {items.map((item) => (
              <RenderRow key={item.key} item={item} threadId={threadId} cwd={cwd} />
            ))}
          </ul>
        )}
        {state.status === 'streaming' && (
          <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            streaming…
          </div>
        )}
        {state.status === 'interrupted' && (
          <div className="flex items-center gap-2 border-t border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-3 w-3" />
            interrupted
          </div>
        )}
        {state.status === 'error' && state.errorMessage && (
          <div className="flex items-center gap-2 border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />
            {state.errorMessage}
          </div>
        )}
        {includeDebug && debugEvents.length > 0 && <DebugStrip events={debugEvents} />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function RenderRow({
  item,
  threadId,
  cwd,
}: {
  item: RenderItem;
  threadId: string;
  cwd: string | undefined;
}) {
  const event = item.event;

  if ('kind' in event && event.kind === 'tool_pair') {
    return (
      <li className="bg-amber-50/30 px-4 py-3 dark:bg-amber-950/10">
        <ToolCallCard pair={event.pair} threadId={threadId} />
      </li>
    );
  }

  switch (event.kind) {
    case 'session_init':
      return (
        <Row icon={Bot} tone="info" label="session">
          {event.model ?? 'unknown model'} · cwd {event.cwd ?? '—'}
          {event.permissionMode && (
            <span className="ml-2 text-muted-foreground">· {event.permissionMode}</span>
          )}
        </Row>
      );
    case 'text':
      return (
        <Row icon={MessageCircle} tone="assistant" label="assistant">
          <Markdown content={event.delta} cwd={cwd} density="compact" className="text-sm leading-relaxed" />
        </Row>
      );
    case 'thinking':
      return (
        <Row icon={Brain} tone="muted" label="thinking">
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              thinking ({event.delta.length} chars)
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-xs italic text-muted-foreground">
              {event.delta}
            </p>
          </details>
        </Row>
      );
    case 'artifact':
      return (
        <Row icon={null} tone="artifact" label="artifact">
          <ArtifactPill path={event.path} mime={event.mime} producedBy={event.producedBy} />
        </Row>
      );
    case 'system_hook':
      if (event.hookEvent === 'user_message') {
        const userText =
          typeof event.content === 'string'
            ? event.content
            : JSON.stringify(event.content);
        return (
          <Row icon={User} tone="user" label="you">
            <Markdown content={userText} cwd={cwd} density="compact" className="text-sm leading-relaxed" />
          </Row>
        );
      }
      if (event.hookEvent === 'cancel') {
        return (
          <li className="flex items-center gap-2 bg-amber-50/30 px-4 py-2 text-xs text-amber-700 dark:bg-amber-950/10 dark:text-amber-300">
            <AlertCircle className="h-3 w-3" />
            interrupted by user
          </li>
        );
      }
      return (
        <Row icon={Bot} tone="muted" label={`hook · ${event.hookEvent}`}>
          {event.name && <code className="text-xs text-muted-foreground">{event.name}</code>}
        </Row>
      );
    case 'rate_limit':
      return (
        <Row icon={CircleAlert} tone="error" label="rate-limit">
          <pre className="text-[11px] text-muted-foreground">{tryStringify(event.info)}</pre>
        </Row>
      );
    case 'done':
      return (
        <Row icon={CheckCircle2} tone="info" label="done">
          <span className="text-xs text-muted-foreground">
            {event.stopReason ?? 'finished'}
            {event.totalCostUsd != null && ` · $${event.totalCostUsd.toFixed(4)}`}
            {event.durationMs != null && ` · ${event.durationMs}ms`}
          </span>
        </Row>
      );
    case 'parse_error':
    case 'unknown':
      return null; // surfaced via DebugStrip in dev
    case 'tool_use':
    case 'tool_result':
      return null; // surfaced via tool_pair render path
    default:
      return null;
  }
}

type Tone = 'user' | 'assistant' | 'tool' | 'artifact' | 'info' | 'muted' | 'error';

const TONE_CLASS: Record<Tone, string> = {
  user: 'bg-blue-50/40 dark:bg-blue-950/15',
  assistant: 'bg-background',
  tool: 'bg-amber-50/30 dark:bg-amber-950/10',
  artifact: 'bg-violet-50/30 dark:bg-violet-950/10',
  info: 'bg-muted/20',
  muted: 'bg-background',
  error: 'bg-red-50/40 dark:bg-red-950/10',
};

function Row({
  icon: Icon,
  tone,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }> | null;
  tone: Tone;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className={cn('flex gap-3 px-4 py-3', TONE_CLASS[tone])}>
      <div className="flex w-20 shrink-0 items-start gap-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        <span>{label}</span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function tryStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DebugStrip({ events }: { events: ChatEvent[] }) {
  return (
    <details className="border-t-2 border-dashed border-border/60 bg-muted/10 px-4 py-2 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        dev: {events.length} unknown / parse-error event{events.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 space-y-1">
        {events.map((e, i) => (
          <li key={i} className="rounded border border-border/40 bg-background p-2 font-mono text-[10px]">
            <span className="mr-2 uppercase tracking-wide text-muted-foreground">{e.kind}</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">{tryStringify(e)}</pre>
          </li>
        ))}
      </ul>
    </details>
  );
}
