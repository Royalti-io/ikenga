// Studio per-artifact chat thread bookkeeping.
//
// Each artifact opened in Studio gets a stable chat threadId so the
// conversation persists across reopens. The mapping lives in localStorage
// keyed by the artifact's on-disk path. Two consumers share this state:
//
//   - `studio-engine-chat.tsx` — mints/looks up the threadId and binds the
//     chat UI to it.
//   - `studio-pane.tsx` — needs the threadId to subscribe to chat events
//     for the ACP tool-result intercept (engine-driven file edits).
//
// Lifted into its own module so the two stay in sync (a duplicate constant
// would silently drift the day someone renames it).

import { useEffect, useState } from 'react';
import { mintThreadId } from '@/chat';

const STUDIO_THREAD_KEY_PREFIX = 'ikenga.studio.thread:';

/** Hook form — returns the threadId once it's been minted (next tick after
 *  mount). Used by chat panels that need to wait for the id before
 *  subscribing. */
export function useStudioThreadId(path: string): string | null {
	const [id, setId] = useState<string | null>(null);
	useEffect(() => {
		setId(getOrMintStudioThreadId(path));
	}, [path]);
	return id;
}

/** Sync form — used by code that runs in `useEffect` and already has its
 *  own dependency on `path`. Returns immediately. Reads existing id from
 *  localStorage or mints + persists a fresh one. */
export function getOrMintStudioThreadId(path: string): string {
	const key = STUDIO_THREAD_KEY_PREFIX + path;
	try {
		const existing = window.localStorage.getItem(key);
		if (existing) return existing;
	} catch {
		// localStorage unavailable — mint without persisting.
	}
	const fresh = mintThreadId();
	try {
		window.localStorage.setItem(key, fresh);
	} catch {
		// noop
	}
	return fresh;
}
