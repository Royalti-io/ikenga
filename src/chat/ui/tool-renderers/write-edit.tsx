import { Pencil } from 'lucide-react';
import type { PairedToolCall } from '../../store';

interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ old_string: string; new_string: string }>;
}

export function WriteEditRenderer({
  pair,
  expanded,
}: {
  pair: PairedToolCall;
  expanded: boolean;
}) {
  const input = (pair.use.input ?? {}) as EditInput;
  const path = input.file_path ?? '(no path)';
  const isError = pair.result?.isError === true;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Pencil className="h-3 w-3 text-muted-foreground" />
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{path}</code>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {pair.use.name}
        </span>
        {isError && (
          <span className="text-[10px] uppercase tracking-wide text-destructive">error</span>
        )}
      </div>
      {expanded && (
        <div className="space-y-2">
          {input.edits ? (
            input.edits.map((e, i) => <DiffPreview key={i} oldStr={e.old_string} newStr={e.new_string} />)
          ) : input.old_string != null || input.new_string != null ? (
            <DiffPreview oldStr={input.old_string ?? ''} newStr={input.new_string ?? ''} />
          ) : input.content != null ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-emerald-500/30 bg-emerald-500/5 p-2 font-mono text-[11px]">
              {input.content}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">no preview available</p>
          )}
          {pair.result && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]">
              {summarizeResult(pair.result.output)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function DiffPreview({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {oldStr && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[11px]">
          <span className="select-none text-rose-500">- </span>
          {oldStr}
        </pre>
      )}
      {newStr && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-emerald-500/30 bg-emerald-500/5 p-2 font-mono text-[11px]">
          <span className="select-none text-emerald-500">+ </span>
          {newStr}
        </pre>
      )}
    </div>
  );
}

function summarizeResult(v: unknown): string {
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
