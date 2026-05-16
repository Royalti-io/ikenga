// Pin composer modal.
//
// Trigger surface: HtmlFrame (full artifact-pane viewer) — opened by the
// element-picker's `contextmenu` capture. The modal collects free-form
// text from the user, shows the cropped element screenshot for context,
// then writes the screenshot to disk, calls `commentCreate`, and asks
// the routing dispatcher to deliver the structured prompt (terminal claude
// if available, otherwise side-pane Chat fallback).
//
// Lives under `shell/src/shell/artifact-grid/` because pins are a
// grid-feature concept today; the surface that *creates* them is just one
// of several consumers and may grow (Studio has its own legacy mode).

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { commentCreate, commentRoute, pinScreenshotWrite } from '@/lib/tauri-cmd';
import type { PickResult } from './element-picker';

interface PinComposerProps {
	open: boolean;
	pick: PickResult | null;
	artifactPath: string;
	onClose: () => void;
}

export function PinComposer({ open, pick, artifactPath, onClose }: PinComposerProps) {
	const qc = useQueryClient();
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Reset state every time we open with a fresh pick. Closing keeps the
	// text around for a moment so the fade-out doesn't show empty content.
	useEffect(() => {
		if (open && pick) {
			setText('');
			setError(null);
			// Defer focus until the Radix portal finishes mounting.
			queueMicrotask(() => textareaRef.current?.focus());
		}
	}, [open, pick]);

	const submit = async () => {
		if (!pick) return;
		const trimmed = text.trim();
		if (!trimmed) {
			setError('Comment text is required.');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const screenshotPath = await pinScreenshotWrite(pick.screenshotBase64);
			const created = await commentCreate({
				artifactPath,
				selector: pick.selector,
				text: trimmed,
				screenshotPath,
				positionX: pick.positionX,
				positionY: pick.positionY,
			});
			// Fire-and-forget routing. The dispatcher logs its own errors;
			// the pin itself is already persisted, so we close the modal
			// even if routing chokes.
			void commentRoute({ id: created.id }).catch((e) =>
				console.error('[pin-composer] route failed', e)
			);
			// Bust the grid's pins query so the new pin pops in immediately.
			void qc.invalidateQueries({ queryKey: ['artifact-grid'] });
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open && pick !== null}
			onOpenChange={(o) => {
				if (!o && !busy) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add pin</DialogTitle>
					<DialogDescription>
						{pick ? (
							<span className="font-mono text-[11px] text-muted-foreground">
								{pick.elementLabel} · <span className="opacity-70">{pick.selector}</span>
							</span>
						) : null}
					</DialogDescription>
				</DialogHeader>

				{pick && (
					<div className="mb-2 flex justify-center rounded border border-border bg-muted/30 p-2">
						<img
							src={`data:image/png;base64,${pick.screenshotBase64}`}
							alt="Pinned element"
							className="max-h-48 max-w-full object-contain"
							style={{
								width: pick.screenshotWidth / (window.devicePixelRatio || 1),
								height: pick.screenshotHeight / (window.devicePixelRatio || 1),
							}}
						/>
					</div>
				)}

				<textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="What needs to change here?"
					rows={4}
					disabled={busy}
					className="w-full resize-none rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void submit();
						}
					}}
				/>

				{error && <p className="text-xs text-destructive">{error}</p>}

				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={busy || !text.trim()} onClick={() => void submit()}>
						{busy ? 'Saving…' : 'Add pin'}
					</Button>
				</DialogFooter>
				<p className="text-right text-[10px] text-muted-foreground">⌘↵ to submit</p>
			</DialogContent>
		</Dialog>
	);
}
