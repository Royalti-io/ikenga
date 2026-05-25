import { FileText } from 'lucide-react';
import type { PairedToolCall } from '../../store';
import { ToolOutputBody } from './tool-output';
import { extractOutput } from './tool-output-extract';

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
	// Reading an image returns image content blocks, not text — surface them as
	// inline images rather than a base64 dump. The collapsed line shows a text
	// line count when there's text, an image count when there isn't.
	const { text, images } = extractOutput(result?.output);
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
				{!isFull && !text && images.length > 0 && (
					<span className="text-[var(--chip-carve)]">
						· {images.length} image{images.length === 1 ? '' : 's'}
					</span>
				)}
			</div>
			{isFull && <ToolOutputBody output={result?.output} imagePath={input?.file_path} />}
		</div>
	);
}

function countLines(s: string): number {
	return s.split('\n').length;
}
