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
	density = 'inline',
}: {
	pair: PairedToolCall;
	density?: 'inline' | 'full';
}) {
	const input = (pair.use.input ?? {}) as EditInput;
	const path = input.file_path ?? '(no path)';
	const isError = pair.result?.isError === true;
	const isFull = density === 'full';

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2 text-xs">
				<Pencil className="h-3 w-3 text-[var(--chip-carve)]" />
				<code className="rounded bg-[var(--rule-soft)] px-1 py-0.5 font-mono text-[11px]">
					{path}
				</code>
				<span className="font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
					{pair.use.name}
				</span>
				{isError && (
					<span className="font-mono text-[10px] uppercase tracking-wider text-[var(--oxblood)]">
						error
					</span>
				)}
			</div>
			{isFull && (
				<div className="space-y-2">
					{input.edits ? (
						input.edits.map((e, i) => (
							<DiffPreview key={i} oldStr={e.old_string} newStr={e.new_string} />
						))
					) : input.old_string != null || input.new_string != null ? (
						<DiffPreview oldStr={input.old_string ?? ''} newStr={input.new_string ?? ''} />
					) : input.content != null ? (
						<pre className="whitespace-pre-wrap break-words rounded border border-[var(--verdigris)]/30 bg-[var(--verdigris)]/5 p-2 font-mono text-[11px]">
							{input.content}
						</pre>
					) : (
						<p className="text-[11px] italic text-[var(--chip-carve)]">no preview available</p>
					)}
					{pair.result && (
						<pre className="whitespace-pre-wrap break-words rounded bg-[var(--rule-soft)] p-2 font-mono text-[11px]">
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
				<pre className="whitespace-pre-wrap break-words rounded border border-[var(--oxblood)]/30 bg-[var(--oxblood)]/5 p-2 font-mono text-[11px]">
					<span className="select-none text-[var(--oxblood)]">- </span>
					{oldStr}
				</pre>
			)}
			{newStr && (
				<pre className="whitespace-pre-wrap break-words rounded border border-[var(--verdigris)]/30 bg-[var(--verdigris)]/5 p-2 font-mono text-[11px]">
					<span className="select-none text-[var(--verdigris)]">+ </span>
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
