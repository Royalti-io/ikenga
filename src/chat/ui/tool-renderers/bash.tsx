import { TerminalSquare } from 'lucide-react';
import type { PairedToolCall } from '../../store';

interface BashInput {
  command?: string;
  description?: string;
  timeout?: number;
}

export function BashRenderer({ pair, expanded }: { pair: PairedToolCall; expanded: boolean }) {
  const input = (pair.use.input ?? {}) as BashInput;
  const command = input.command ?? '';
  const result = pair.result;
  const { stdout, stderr } = splitOutput(result?.output);
  const isError = result?.isError === true;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-xs">
        <TerminalSquare className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {expanded ? command : truncate(command, 80)}
        </code>
      </div>
      {input.description && expanded && (
        <p className="text-[11px] italic text-muted-foreground">{input.description}</p>
      )}
      {expanded && (
        <>
          {stdout && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {stdout}
            </pre>
          )}
          {stderr && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/30 bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
              {stderr}
            </pre>
          )}
          {!stdout && !stderr && result && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]">
              {flatten(result.output)}
            </pre>
          )}
          {isError && !stderr && (
            <p className="text-[11px] text-destructive">tool error</p>
          )}
        </>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
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

/** Best-effort split of bash tool output into stdout/stderr buckets. The
 *  Bash tool surfaces them in a single string with `<stdout>...</stdout>`
 *  and `<stderr>...</stderr>` tags, sometimes; otherwise the whole thing
 *  is stdout. */
function splitOutput(v: unknown): { stdout: string; stderr: string } {
  const text = flatten(v);
  if (!text) return { stdout: '', stderr: '' };
  const stdoutMatch = /<stdout>([\s\S]*?)<\/stdout>/.exec(text);
  const stderrMatch = /<stderr>([\s\S]*?)<\/stderr>/.exec(text);
  if (stdoutMatch || stderrMatch) {
    return {
      stdout: stdoutMatch ? stdoutMatch[1].trim() : '',
      stderr: stderrMatch ? stderrMatch[1].trim() : '',
    };
  }
  return { stdout: text, stderr: '' };
}
