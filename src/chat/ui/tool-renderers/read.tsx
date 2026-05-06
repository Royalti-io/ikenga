import { FileText } from 'lucide-react';
import type { PairedToolCall } from '../../store';

export function ReadRenderer({ pair, expanded }: { pair: PairedToolCall; expanded: boolean }) {
  const input = pair.use.input as { file_path?: string; offset?: number; limit?: number } | null;
  const path = input?.file_path ?? '(no path)';
  const result = pair.result;
  const text = typeof result?.output === 'string' ? result.output : stringifyOutput(result?.output);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <FileText className="h-3 w-3 text-muted-foreground" />
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{path}</code>
        {input?.offset != null && (
          <span className="text-muted-foreground">offset {input.offset}</span>
        )}
        {input?.limit != null && (
          <span className="text-muted-foreground">limit {input.limit}</span>
        )}
        {!expanded && text && (
          <span className="text-muted-foreground">· {countLines(text)} lines</span>
        )}
      </div>
      {expanded && text && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
          {text}
        </pre>
      )}
    </div>
  );
}

function countLines(s: string): number {
  return s.split('\n').length;
}

function stringifyOutput(v: unknown): string {
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
