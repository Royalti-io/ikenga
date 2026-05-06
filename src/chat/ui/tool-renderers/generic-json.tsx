import { Wrench } from 'lucide-react';
import type { PairedToolCall } from '../../store';

export function GenericJsonRenderer({
  pair,
  expanded,
}: {
  pair: PairedToolCall;
  expanded: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-[11px]">{pair.use.name}</span>
        {!expanded && pair.use.input != null && (
          <span className="truncate text-muted-foreground">
            {summarize(pair.use.input)}
          </span>
        )}
      </div>
      {expanded && (
        <>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">input</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {tryStringify(pair.use.input)}
            </pre>
          </div>
          {pair.result && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                output{pair.result.isError ? ' (error)' : ''}
              </p>
              <pre
                className={`max-h-48 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-[11px] ${
                  pair.result.isError
                    ? 'border border-destructive/30 bg-destructive/10 text-destructive'
                    : 'bg-muted/40'
                }`}
              >
                {tryStringify(pair.result.output)}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function summarize(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`;
  }
  return String(v);
}

function tryStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
