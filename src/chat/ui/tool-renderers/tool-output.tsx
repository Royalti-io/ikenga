/**
 * Shared tool-output rendering: text in a `<pre>` plus inline image thumbnails.
 *
 * The extraction logic (`extractOutput`) lives in `./tool-output-extract` so
 * this file exports only the component (keeps react-refresh Fast Refresh
 * working). See that module for the supported image-block wire shapes.
 */

import { useMemo } from 'react';
import { cn } from '@/components/ui/utils';
import { usePaneStore } from '@/lib/panes/pane-store';
import { extractOutput } from './tool-output-extract';

/**
 * Render a tool result's output as text (in a `<pre>`) plus any inline images.
 * `preClassName` styles the text block so each caller keeps its own chrome.
 *
 * Images render as height-capped **thumbnails**, not full-bleed — the tool pill
 * caps its panel at 320px, and an uncapped tall image would overflow into an
 * inner scrollbar (bad: you'd scrub a tiny image inside a tiny box). When
 * `imagePath` is set (e.g. a `Read` of a file), the thumbnail is a button that
 * opens the file full-size in the artifact viewer pane — same destination the
 * file explorer uses. Base64-only images (no backing file) stay as static
 * thumbnails.
 */
export function ToolOutputBody({
	output,
	preClassName,
	imagePath,
}: {
	output: unknown;
	preClassName?: string;
	/** Backing file path for image output, if any. Makes thumbnails clickable
	 *  to open in the viewer. */
	imagePath?: string;
}) {
	const { text, images } = useMemo(() => extractOutput(output), [output]);
	const openInViewer = usePaneStore((s) => s.addTab);
	const focusedId = usePaneStore((s) => s.focusedId);
	if (!text && images.length === 0) return null;

	const thumbClass = 'max-h-48 w-auto rounded-md border border-[var(--rule)] object-contain';

	return (
		<div className="space-y-2">
			{text && (
				<pre
					className={cn(
						'whitespace-pre-wrap break-words rounded border border-[var(--rule)] bg-[var(--rule-soft)] p-2 font-mono text-[11px]',
						preClassName
					)}
				>
					{text}
				</pre>
			)}
			{images.map((img, i) =>
				imagePath ? (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: images are positional + static
						key={i}
						type="button"
						onClick={() => openInViewer(focusedId, { kind: 'artifact', path: imagePath })}
						className="block cursor-zoom-in rounded-md transition-opacity hover:opacity-90"
						title={`Open ${imagePath} in viewer`}
					>
						<img src={img.src} alt="tool output thumbnail" className={thumbClass} />
					</button>
				) : (
					<img
						// biome-ignore lint/suspicious/noArrayIndexKey: images are positional + static
						key={i}
						src={img.src}
						alt="tool output thumbnail"
						className={thumbClass}
					/>
				)
			)}
		</div>
	);
}
