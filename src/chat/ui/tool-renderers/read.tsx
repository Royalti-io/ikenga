import { FileText } from 'lucide-react';
import type { PairedToolCall } from '../../store';

export function ReadRenderer({
	pair,
	density = 'inline',
}: {
	pair: PairedToolCall;
	density?: 'inline' | 'full';
}) {
	const input = pair.use.input as { file_path?: string; offset?: number; limit?: number } | null;
	const path = input?.file_path ?? '(no path)';
	const result = pair.result;
	const text = typeof result?.output === 'string' ? result.output : stringifyOutput(result?.output);
	const isFull = density === 'full';

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2 text-xs">
				<FileText className="h-3 w-3 text-[var(--chip-carve)]" />
				<code className="rounded bg-[var(--rule-soft)] px-1 py-0.5 font-mono text-[11px]">
					{path}
				</code>
				{input?.offset != null && (
					<span className="text-[var(--chip-carve)]">offset {input.offset}</span>
				)}
				{input?.limit != null && (
					<span className="text-[var(--chip-carve)]">limit {input.limit}</span>
				)}
				{!isFull && text && (
					<span className="text-[var(--chip-carve)]">· {countLines(text)} lines</span>
				)}
			</div>
			{isFull && text && (
				<pre className="whitespace-pre-wrap break-words rounded border border-[var(--rule)] bg-[var(--rule-soft)] p-2 font-mono text-[11px]">
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
