// Detached viewer surface (plans/multi-window WP-06).
//
// Renders a file via the existing ViewerRouter in a thin detached window —
// no activity-bar, sidebar, or pane-group chrome.
//
// The pop-out affordance in `pane/views/artifact-view.tsx` encodes the file
// path in the `surface_set` entry: `"viewer:<path>"`. The surface registry
// resolves by prefix (`"viewer"`); this component extracts the suffix.
// Splitting on the FIRST colon only so absolute paths (e.g. `/home/user/file`)
// survive — `"viewer:/home/user/file.md"` → path = `"/home/user/file.md"`.
//
// Viewer state (MIME detection, render) lives entirely in ViewerRouter and
// its renderer components — no cross-window sync is needed because the file
// is read directly from disk. The detached window is a second read-only eye
// on the same file.
//
// Live-path-open verification: needs a built + running shell.

import { FileText } from 'lucide-react';

import { FeedbackState } from '@/components/ui/feedback-state';
import { ViewerRouter } from '@/viewer/auto-router';

import type { DetachedSurfaceProps } from '../registry';

/** Extract the file path encoded in `"viewer:<path>"` by the pop-out. */
function parsePath(surfaces: string[]): string | null {
	const entry = surfaces[0] ?? '';
	const colon = entry.indexOf(':');
	if (colon < 1) return null;
	const path = entry.slice(colon + 1);
	return path.length > 0 ? path : null;
}

export default function ViewerSurface({ ctx }: DetachedSurfaceProps) {
	const path = parsePath(ctx.surfaces);

	if (!path) {
		return (
			<FeedbackState
				variant="empty"
				fill
				icon={FileText}
				heading="No file"
				body="Open this window via the viewer pane pop-out button."
			/>
		);
	}

	// ViewerRouter owns its own header (filename + MIME badge) when
	// `chromeless` is not set — that doubles as this window's title bar.
	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			<ViewerRouter path={path} source="pane" editable />
		</div>
	);
}
