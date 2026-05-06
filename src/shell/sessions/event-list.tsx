import { useMemo } from 'react';
import {
  Bot,
  Brain,
  CheckCircle2,
  CircleAlert,
  FileOutput,
  MessageCircle,
  Wrench,
} from 'lucide-react';

import type { ChatEvent } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';

/**
 * Phase 3 placeholder for the chat thread. Phase 5 replaces this with the
 * full `chat/ui/thread.tsx` (tool cards, artifact pills, virtualized list,
 * adapter switcher). For now: a flat list of parsed events with enough
 * affordance to verify the parsers and serve as the "Chat view" escape hatch
 * during dogfooding.
 */
export function EventList({
  events,
  className,
}: {
  events: ChatEvent[];
  className?: string;
}) {
  // Coalesce contiguous text deltas so streaming doesn't render every chunk
  // as its own row.
  const rows = useMemo(() => coalesceText(events), [events]);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No events yet. Send a prompt to start the conversation.
      </div>
    );
  }

  return (
    <div className={cn('h-full overflow-auto', className)}>
      <ul className="divide-y divide-border">
        {rows.map((event, i) => (
          <EventRow key={`${i}-${event.kind}`} event={event} />
        ))}
      </ul>
    </div>
  );
}

function EventRow({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'session_init':
      return (
        <Row icon={Bot} tone="info" label="session">
          {event.model ?? 'unknown model'} · cwd {event.cwd ?? '—'}
        </Row>
      );
    case 'text':
      return (
        <Row icon={MessageCircle} tone="assistant" label="assistant">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{event.delta}</p>
        </Row>
      );
    case 'thinking':
      return (
        <Row icon={Brain} tone="muted" label="thinking">
          <p className="whitespace-pre-wrap text-xs italic text-muted-foreground">
            {event.delta}
          </p>
        </Row>
      );
    case 'tool_use':
      return (
        <Row icon={Wrench} tone="tool" label={`tool · ${event.name}`}>
          <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] font-mono">
            {tryStringify(event.input)}
          </pre>
        </Row>
      );
    case 'tool_result':
      return (
        <Row
          icon={event.isError ? CircleAlert : CheckCircle2}
          tone={event.isError ? 'error' : 'tool-result'}
          label={event.isError ? 'tool error' : 'tool result'}
        >
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] font-mono">
            {renderToolOutput(event.output)}
          </pre>
        </Row>
      );
    case 'artifact':
      return (
        <Row icon={FileOutput} tone="artifact" label="artifact">
          <span className="text-xs">
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{event.path}</code>
            <span className="ml-2 text-muted-foreground">{event.mime}</span>
          </span>
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
    case 'system_hook':
      return (
        <Row icon={Bot} tone="muted" label={`hook · ${event.hookEvent}`}>
          {event.name && (
            <code className="text-xs text-muted-foreground">{event.name}</code>
          )}
        </Row>
      );
    case 'rate_limit':
      return (
        <Row icon={CircleAlert} tone="error" label="rate-limit">
          <pre className="text-[11px] text-muted-foreground">
            {tryStringify(event.info)}
          </pre>
        </Row>
      );
    case 'parse_error':
      return (
        <Row icon={CircleAlert} tone="error" label="parse error">
          <p className="text-xs font-medium">{event.message}</p>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
            {event.line}
          </pre>
        </Row>
      );
    case 'unknown':
      return null; // hide noise; available in raw jsonl
    default:
      return null;
  }
}

type Tone =
  | 'assistant'
  | 'tool'
  | 'tool-result'
  | 'artifact'
  | 'info'
  | 'muted'
  | 'error';

const TONE_CLASS: Record<Tone, string> = {
  assistant: 'bg-background',
  tool: 'bg-amber-50/30 dark:bg-amber-950/10',
  'tool-result': 'bg-emerald-50/30 dark:bg-emerald-950/10',
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
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className={cn('flex gap-3 px-4 py-3', TONE_CLASS[tone])}>
      <div className="flex w-20 shrink-0 items-start gap-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
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

function renderToolOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text ?? '');
        }
        return tryStringify(block);
      })
      .join('\n');
  }
  return tryStringify(value);
}

function coalesceText(events: ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === 'text' &&
      e.kind === 'text'
    ) {
      out[out.length - 1] = { kind: 'text', delta: last.delta + e.delta };
      continue;
    }
    if (
      last &&
      last.kind === 'thinking' &&
      e.kind === 'thinking'
    ) {
      out[out.length - 1] = { kind: 'thinking', delta: last.delta + e.delta };
      continue;
    }
    out.push(e);
  }
  return out;
}
