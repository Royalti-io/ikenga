// Async resolver for pane addresses that need a round-trip to the host.
//
// `parsePaneAddress` is intentionally synchronous — it's called on every
// keystroke in the URL bar to validate the draft, so it can't block on
// Tauri commands. The only address shape that needs async resolution today
// is `ikenga://artifact/<id>`, which looks up a pinned artifact's on-disk
// path through the activity-bar registry.
//
// The contract: parser keeps the literal URI in `view.path`; the URL bar
// (and any other navigation site) passes the parsed view through this
// resolver before mounting. The resolver returns the rewritten view, or
// null if the URI couldn't be resolved (no pin claims the id) — the caller
// should treat null the same way as a parser failure (red-ring the input,
// don't navigate).

import { activityPinsResolveArtifact, activityPinsTouchOpen } from '@/lib/tauri-cmd';
import type { PaneView } from './types';

const IKENGA_ARTIFACT_PREFIX = 'ikenga://artifact/';

export interface ResolveResult {
	/** The rewritten view, or null if resolution failed. */
	view: PaneView | null;
	/** True when the input matched the `ikenga://artifact/<id>` shape. False
	 *  for pass-through views (path/URL artifacts, route views). Lets the
	 *  caller distinguish "I tried and failed" from "no resolution needed". */
	resolved: boolean;
}

/** Resolve any address shapes that need a host round-trip. Pass-through for
 *  views that don't need it. Fires `activityPinsTouchOpen` as a side-effect
 *  on a successful artifact resolution; failures from that secondary call
 *  are swallowed (recency tracking is best-effort, never blocks navigation). */
export async function resolveArtifactAddress(view: PaneView): Promise<ResolveResult> {
	if (view.kind !== 'artifact') {
		return { view, resolved: false };
	}
	if (!view.path.startsWith(IKENGA_ARTIFACT_PREFIX)) {
		return { view, resolved: false };
	}
	const id = view.path.slice(IKENGA_ARTIFACT_PREFIX.length);
	if (!id) {
		return { view: null, resolved: true };
	}
	const pin = await activityPinsResolveArtifact(id);
	if (!pin) {
		return { view: null, resolved: true };
	}
	// Side-effect: bump recency. Fire-and-forget — a transient failure here
	// (db locked, etc.) shouldn't keep the pane from mounting.
	void activityPinsTouchOpen(pin.id).catch(() => {});
	return { view: { kind: 'artifact', path: pin.target }, resolved: true };
}
