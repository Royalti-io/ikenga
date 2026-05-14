import { Wrench } from 'lucide-react';
import type { PairedToolCall } from '../../store';

export function GenericJsonRenderer({
	pair,
	density = 'inline',
}: {
	pair: PairedToolCall;
	density?: 'inline' | 'full';
}) {
	const isFull = density === 'full';
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2 text-xs">
				<Wrench className="h-3 w-3 text-[var(--chip-carve)]" />
				<span className="font-mono text-[11px]">{pair.use.name}</span>
				{!isFull && pair.use.input != null && (
					<span className="truncate text-[var(--chip-carve)]">{summarize(pair.use.input)}</span>
				)}
			</div>
			{isFull && (
				<>
					<div>
						<p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
							input
						</p>
						<pre className="whitespace-pre-wrap break-words rounded border border-[var(--rule)] bg-[var(--rule-soft)] p-2 font-mono text-[11px]">
							{tryStringify(pair.use.input)}
						</pre>
					</div>
					{pair.result && (
						<div>
							<p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
								output{pair.result.isError ? ' (error)' : ''}
							</p>
							<pre
								className={`whitespace-pre-wrap break-words rounded p-2 font-mono text-[11px] ${
									pair.result.isError
										? 'border border-[var(--oxblood)]/30 bg-[var(--oxblood)]/10 text-[var(--oxblood)]'
										: 'bg-[var(--rule-soft)]'
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
