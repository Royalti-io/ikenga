import { Bot, ChevronRight } from 'lucide-react';
import { useChatStore, type PairedToolCall, findToolChildren } from '../../store';
import { ToolCallCard } from '../tool-call-card';

interface TaskInput {
  subagent_type?: string;
  description?: string;
  prompt?: string;
}

export function TaskRenderer({
  pair,
  expanded,
  threadId,
}: {
  pair: PairedToolCall;
  expanded: boolean;
  threadId: string;
}) {
  const input = (pair.use.input ?? {}) as TaskInput;
  const events = useChatStore((s) => s.threads[threadId]?.events ?? []);
  const children = findToolChildren(events, pair.use.id);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-xs">
        <Bot className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {input.subagent_type && (
            <span className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300">
              {input.subagent_type}
            </span>
          )}
          {input.description && (
            <span className="ml-2 text-foreground">{input.description}</span>
          )}
        </div>
      </div>
      {expanded && (
        <>
          {input.prompt && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {input.prompt}
            </pre>
          )}
          {children.length > 0 && (
            <div className="ml-4 space-y-2 border-l-2 border-violet-500/30 pl-3">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <ChevronRight className="h-3 w-3" />
                {children.length} child{children.length === 1 ? '' : 'ren'}
              </div>
              {children.map((child) => (
                <ToolCallCard
                  key={`child:${child.use.id}`}
                  pair={child}
                  threadId={threadId}
                  isChild
                />
              ))}
            </div>
          )}
          {pair.result && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]">
              {flatten(pair.result.output)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function flatten(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? String((b as { text: unknown }).text ?? '')
          : JSON.stringify(b),
      )
      .join('\n');
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
