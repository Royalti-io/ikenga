// Compare density — placeholder for Phase 3.
//
// Phase 2 lands the type slot (`density: 'compare'` + the `vs` field)
// and a stub body so the route/pane plumbing is complete. Phase 3
// fills in the split-pane renderer, swap / make-canonical actions,
// and the `compare` scope chip in chat.

import { GitCompare } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';

interface StudioCompareProps {
	paneId: string;
	a: string;
	b: string;
}

export function StudioCompare({ paneId, a, b }: StudioCompareProps) {
	const replaceView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	const back = (path: string) =>
		replaceView(paneId, { kind: 'artifact-studio', path, density: 'loupe' });

	return (
		<div className="flex h-full w-full flex-col bg-background" data-pane-id={paneId}>
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs">
				<GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="font-mono">{a.split('/').pop()}</span>
				<span className="text-muted-foreground">↔</span>
				<span className="font-mono">{b.split('/').pop()}</span>
			</div>
			<div className="flex flex-1 items-center justify-center p-8">
				<div className="max-w-md rounded border border-dashed border-border bg-muted/10 p-8 text-center">
					<div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
						Compare — Phase 3
					</div>
					<div className="mb-4 text-sm text-foreground">
						Side-by-side renderer, swap, and make-canonical actions land in the next phase. Open
						either side in loupe to keep going.
					</div>
					<div className="flex justify-center gap-2">
						<button
							type="button"
							onClick={() => back(a)}
							className="rounded border border-border bg-background px-3 py-1 text-xs hover:bg-foreground/5"
						>
							Open {a.split('/').pop()}
						</button>
						<button
							type="button"
							onClick={() => back(b)}
							className="rounded border border-border bg-background px-3 py-1 text-xs hover:bg-foreground/5"
						>
							Open {b.split('/').pop()}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
