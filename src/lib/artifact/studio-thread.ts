// Studio per-artifact chat thread bookkeeping.
//
// Each artifact opened in Studio gets a stable chat threadId so the
// conversation persists across reopens. The mapping lives in localStorage,
// keyed by the artifact's **version family** (parent dir + version stem
// + extension) — variants of the same artifact (`foo.html`, `foo-v2.html`,
// `foo_3.html`, `foo-v4-dark.html`) share one thread, because they're
// revisions of the same work. Switching between siblings of the same
// family doesn't reload the chat. Different artifacts in the same folder
// get separate threads.
//
// Two consumers share this state:
//
//   - `studio-engine-chat.tsx` — mints/looks up the threadId and binds the
//     chat UI to it.
//   - `studio-pane.tsx` — needs the threadId to subscribe to chat events
//     for the ACP tool-result intercept (engine-driven file edits).

import { useMemo } from 'react';
import { mintThreadId } from '@/chat';
import { versionStem } from '@/shell/artifact-studio/version-strip';

const STUDIO_THREAD_KEY_PREFIX = 'ikenga.studio.thread:';

/** Derive the version-family key for an artifact path: parent dir +
 *  stem + extension. Variants of the same family produce the same key. */
function familyKey(path: string): string {
	const slash = path.lastIndexOf('/');
	const dir = slash >= 0 ? path.slice(0, slash) : '.';
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	return `${dir}/${versionStem(base)}${ext}`;
}

/** Hook form — returns the threadId synchronously. `useMemo` on the
 *  family key keeps the id stable when switching between version siblings
 *  in the same pane (no remount, no "Loading chat…" flicker). */
export function useStudioThreadId(path: string): string {
	return useMemo(() => getOrMintStudioThreadId(path), [familyKey(path)]);
}

/** Sync form — reads existing family-keyed id from localStorage or mints +
 *  persists a fresh one. */
export function getOrMintStudioThreadId(path: string): string {
	const key = STUDIO_THREAD_KEY_PREFIX + familyKey(path);
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
