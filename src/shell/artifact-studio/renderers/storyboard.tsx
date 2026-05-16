// Storyboard renderer — Studio surface for `*.storyboard.json` artifacts.
//
// The storyboard format is a JSON document describing an ordered set of
// frames (titles + image refs + optional voice-over text) used by the
// video engine pkg. This renderer reads the file, validates the shape
// loosely (best-effort), and renders a scrubable horizontal frame
// strip plus a focused-frame inspector below. Pin support against
// (frame-index, region) lands when the unified comment system grows
// renderer-specific anchors.

import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { fsRead } from '@/lib/tauri-cmd';
import type { Renderer, RendererMountProps } from './types';

export interface StoryboardFrame {
	title?: string;
	image?: string;
	voiceover?: string;
	durationMs?: number;
	[k: string]: unknown;
}

export interface StoryboardDoc {
	title?: string;
	frames: StoryboardFrame[];
}

/** Pure: parse + normalize a storyboard JSON blob. Returns null on
 *  any malformed input — the renderer surfaces an "invalid storyboard"
 *  message rather than throwing. */
export function parseStoryboard(raw: string): StoryboardDoc | null {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!v || typeof v !== 'object') return null;
	const obj = v as { title?: unknown; frames?: unknown };
	if (!Array.isArray(obj.frames)) return null;
	const frames: StoryboardFrame[] = obj.frames
		.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
		.map((f) => ({
			title: typeof f.title === 'string' ? f.title : undefined,
			image: typeof f.image === 'string' ? f.image : undefined,
			voiceover: typeof f.voiceover === 'string' ? f.voiceover : undefined,
			durationMs: typeof f.durationMs === 'number' ? f.durationMs : undefined,
		}));
	return {
		title: typeof obj.title === 'string' ? obj.title : undefined,
		frames,
	};
}

function StoryboardRendererComponent({ path }: RendererMountProps) {
	const [doc, setDoc] = useState<StoryboardDoc | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeIdx, setActiveIdx] = useState(0);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fsRead(path);
				const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(res.bytes));
				const parsed = parseStoryboard(text);
				if (cancelled) return;
				if (!parsed) {
					setError('invalid storyboard JSON (expected `{ frames: [...] }`)');
					setDoc(null);
				} else {
					setError(null);
					setDoc(parsed);
					setActiveIdx(0);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path]);

	if (error) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-destructive">
				Storyboard: {error}
			</div>
		);
	}
	if (!doc) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
				Loading storyboard…
			</div>
		);
	}
	if (doc.frames.length === 0) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
				Storyboard has no frames.
			</div>
		);
	}

	const active = doc.frames[activeIdx] ?? doc.frames[0];
	return (
		<div className="flex h-full w-full flex-col bg-background">
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 py-1.5 text-xs">
				<Film className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="font-mono">{doc.title ?? 'Storyboard'}</span>
				<span className="ml-auto font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
					frame {activeIdx + 1} / {doc.frames.length}
				</span>
			</div>
			<div className="flex flex-1 min-h-0 flex-col">
				<div className="flex flex-1 min-h-0 items-center justify-center overflow-auto bg-muted/5 p-4">
					{active.image ? (
						<img
							src={active.image}
							alt={active.title ?? `frame ${activeIdx + 1}`}
							className="max-h-full max-w-full object-contain"
						/>
					) : (
						<div className="rounded border border-dashed border-border bg-muted/10 px-8 py-12 text-sm text-muted-foreground">
							{active.title ?? `Frame ${activeIdx + 1}`}
						</div>
					)}
				</div>
				{active.voiceover && (
					<div className="shrink-0 border-t border-border bg-muted/10 px-4 py-2 text-sm italic text-foreground/80">
						"{active.voiceover}"
					</div>
				)}
				<div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-muted/20 px-3 py-2">
					{doc.frames.map((f, i) => {
						const isActive = i === activeIdx;
						return (
							<button
								key={i}
								type="button"
								onClick={() => setActiveIdx(i)}
								title={f.title ?? `frame ${i + 1}`}
								className={
									'relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded border font-mono text-[10px] transition-colors ' +
									(isActive
										? 'border-foreground bg-background text-foreground'
										: 'border-border bg-muted/10 text-muted-foreground hover:border-foreground/40 hover:text-foreground')
								}
							>
								{f.image ? (
									<img
										src={f.image}
										alt=""
										className="absolute inset-0 h-full w-full object-cover opacity-80"
									/>
								) : null}
								<span className="relative z-10 rounded bg-background/80 px-1">{i + 1}</span>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export const storyboardRenderer: Renderer = {
	kind: 'storyboard',
	match(path, manifestKind) {
		if (manifestKind === 'storyboard') return true;
		return path.toLowerCase().endsWith('.storyboard.json');
	},
	Component: StoryboardRendererComponent,
};
