import { TerminalSquare } from 'lucide-react';
import type { PairedToolCall } from '../../store';

interface BashInput {
	command?: string;
	description?: string;
	timeout?: number;
}

export function BashRenderer({
	pair,
	density = 'inline',
}: {
	pair: PairedToolCall;
	density?: 'inline' | 'full';
}) {
	const input = (pair.use.input ?? {}) as BashInput;
	const command = input.command ?? '';
	const result = pair.result;
	const { stdout, stderr } = splitOutput(result?.output);
	const isError = result?.isError === true;
	const isFull = density === 'full';

	return (
		<div className="space-y-2">
			<div className="flex items-start gap-2 text-xs">
				<TerminalSquare className="mt-0.5 h-3 w-3 shrink-0 text-[var(--chip-carve)]" />
				<code className="break-all rounded bg-[var(--rule-soft)] px-1 py-0.5 font-mono text-[11px]">
					{isFull ? command : truncate(command, 80)}
				</code>
			</div>
			{input.description && isFull && (
				<p className="text-[11px] italic text-[var(--chip-carve)]">{input.description}</p>
			)}
			{isFull && (
				<>
					{stdout && (
						<pre className="whitespace-pre-wrap break-words rounded border border-[var(--rule)] bg-[var(--rule-soft)] p-2 font-mono text-[11px]">
							{stdout}
						</pre>
					)}
					{stderr && (
						<pre className="whitespace-pre-wrap break-words rounded border border-[var(--oxblood)]/40 bg-[var(--oxblood)]/10 p-2 font-mono text-[11px] text-[var(--oxblood)]">
							{stderr}
						</pre>
					)}
					{!stdout && !stderr && result && (
						<pre className="whitespace-pre-wrap break-words rounded bg-[var(--rule-soft)] p-2 font-mono text-[11px]">
							{flatten(result.output)}
						</pre>
					)}
					{isError && !stderr && <p className="text-[11px] text-[var(--oxblood)]">tool error</p>}
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
					: JSON.stringify(b)
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
