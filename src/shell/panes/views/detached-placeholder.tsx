// Shown in the PRIMARY window in place of a pane whose surface has been popped
// out into its own window (plans/multi-window). Stops the duplicate render —
// the live surface lives in the detached window until the user brings it back.
//
// "Bring it back" closes the detached window via `reclaimSurface`; the
// `window://closed` event clears the tracker and this pane re-mounts the live
// surface inline.

import { ExternalLink, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { reclaimSurface } from '@/lib/window/detached-surfaces';

interface DetachedSurfacePlaceholderProps {
	/** The `surface_set` id hosted by the detached window (e.g. `"chat:<id>"`). */
	surfaceId: string;
	/** Surface noun for the copy, e.g. "chat", "terminal", "file". */
	noun: string;
}

export function DetachedSurfacePlaceholder({ surfaceId, noun }: DetachedSurfacePlaceholderProps) {
	return (
		<FeedbackState
			variant="empty"
			fill
			icon={ExternalLink}
			heading="Popped out"
			body={
				<span className="flex flex-col items-center gap-1">
					<span className="text-[12px]">This {noun} is open in a separate window.</span>
					<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
						Detached
					</span>
				</span>
			}
			action={
				<Button
					size="sm"
					onClick={() => void reclaimSurface(surfaceId)}
					className="h-7 px-3 text-xs"
				>
					<Undo2 className="mr-1 h-3 w-3" />
					Bring it back
				</Button>
			}
		/>
	);
}
