// Scratchpad pane view. Loads on mount via /iyke/scratchpad/read; saves
// the textarea body on 1s-debounced edits via /iyke/scratchpad/write.
// Scope is captured at tab-creation time and stored on the PaneView, so
// switching the active project doesn't strand this tab.

import { useEffect, useRef, useState } from 'react';

import { readScratchpad, writeScratchpad } from '@/lib/iyke/memory';

interface ScratchpadViewProps {
	scope: string;
	name: string;
}

type Status = 'loading' | 'loaded' | 'not_found' | 'error' | 'saving' | 'saved';

const AUTOSAVE_MS = 1000;

export function ScratchpadView({ scope, name }: ScratchpadViewProps) {
	const [body, setBody] = useState('');
	const [status, setStatus] = useState<Status>('loading');
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const lastSavedRef = useRef<string>('');
	const saveTimerRef = useRef<number | null>(null);

	// Initial load.
	useEffect(() => {
		let cancelled = false;
		setStatus('loading');
		setErrorMsg(null);
		readScratchpad(name, scope)
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					setBody('');
					lastSavedRef.current = '';
					setStatus('not_found');
				} else {
					setBody(res.body);
					lastSavedRef.current = res.body;
					setStatus('loaded');
				}
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setStatus('error');
				setErrorMsg(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
		};
	}, [scope, name]);

	function scheduleSave(next: string) {
		if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
		saveTimerRef.current = window.setTimeout(() => {
			saveTimerRef.current = null;
			if (next === lastSavedRef.current) return;
			setStatus('saving');
			writeScratchpad(name, next, scope)
				.then(() => {
					lastSavedRef.current = next;
					setStatus('saved');
				})
				.catch((e: unknown) => {
					setStatus('error');
					setErrorMsg(e instanceof Error ? e.message : String(e));
				});
		}, AUTOSAVE_MS);
	}

	const statusLabel = (() => {
		switch (status) {
			case 'loading':
				return 'loading…';
			case 'loaded':
				return 'loaded';
			case 'not_found':
				return 'new — will be created on first save';
			case 'saving':
				return 'saving…';
			case 'saved':
				return 'saved';
			case 'error':
				return `error: ${errorMsg ?? ''}`;
		}
	})();

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
				<div className="truncate font-mono">
					<span className="font-medium text-foreground">{name}</span>
					<span className="ml-2 opacity-60">{scope}</span>
				</div>
				<div className="ml-3 shrink-0 tabular-nums">{statusLabel}</div>
			</div>
			<textarea
				className="h-full min-h-0 flex-1 resize-none bg-background p-3 font-mono text-sm leading-relaxed outline-none"
				value={body}
				placeholder="Write anything — autosaves to the active project's scratchpad."
				onChange={(e) => {
					const next = e.target.value;
					setBody(next);
					scheduleSave(next);
				}}
				spellCheck={false}
			/>
		</div>
	);
}
