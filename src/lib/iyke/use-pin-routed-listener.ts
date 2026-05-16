// Shell-level listener for `pin://routed` events.
//
// When the routing dispatcher (commands/comment_route.rs) decides a pin
// belongs in side-pane Chat — auto-detect fall-through (no claude PTY)
// or an explicit `Sidepane`/`Both` override — it emits `pin://routed`
// with the full structured payload. We resolve a target chat thread
// using this priority (matches the user choice in
// plans/shell/2026-05-16-artifact-grid-brainstorm.md):
//
//   1. focused leaf's active tab if it's a chat → use that sessionId
//   2. else first chat tab found in any leaf
//   3. else create a new chat tab in the focused leaf
//
// Then we:
//   - focus the leaf + switch to that tab (so the user sees the prompt land),
//   - enqueue a short `"address pin #N (artifact: … · selector: …)"` prompt
//     keyed by the thread id in `usePendingPrompts`.
//
// The Composer for that thread consumes the queue on mount/effect and
// pre-fills its textarea so the user just presses Enter. We intentionally
// don't auto-submit — the user might be deep in another conversation and
// silently sending into a hidden thread would surprise them.

import { useEffect } from 'react';
import { listenPinRouted, type PinRoutedEvent } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { usePendingPrompts } from '@/chat/pending-prompts';
import { mintThreadId } from '@/chat';
import type { PaneView } from '@/lib/panes/types';

function newChatView(): PaneView {
	return { kind: 'chat', sessionId: mintThreadId() };
}

function formatPinPrompt(e: PinRoutedEvent): string {
	// Mirrors the terminal-PTY write in commands/comment_route.rs so a
	// claude session sees the same shape on either sink. The agent then
	// calls `mcp-iyke.pin_read` for the full payload (screenshot, status,
	// timestamps) rather than relying on the inline summary.
	return `address pin #${e.id} (artifact: ${e.artifact_path} · selector: ${e.selector})`;
}

/** Locate the chat tab to deliver a pin prompt into, by the priority
 *  documented at the top of this file. Returns `{ leafId, tabIdx,
 *  threadId, created }`; `created` is true when we had to open a new
 *  chat tab (the caller may want to log that). */
function resolveOrOpenChatTarget(): {
	leafId: string;
	tabIdx: number;
	threadId: string;
	created: boolean;
} {
	const store = usePaneStore.getState();
	const { root, focusedId } = store;

	const focusedLeaf = findLeaf(root, focusedId);
	if (focusedLeaf) {
		const active = focusedLeaf.tabs[focusedLeaf.activeTabIdx];
		if (active?.kind === 'chat') {
			return {
				leafId: focusedLeaf.id,
				tabIdx: focusedLeaf.activeTabIdx,
				threadId: active.sessionId,
				created: false,
			};
		}
	}

	// Scan all leaves for any chat tab.
	const leaves = collectLeaves(root);
	for (const leaf of leaves) {
		for (let i = 0; i < leaf.tabs.length; i++) {
			const t = leaf.tabs[i];
			if (t.kind === 'chat') {
				return { leafId: leaf.id, tabIdx: i, threadId: t.sessionId, created: false };
			}
		}
	}

	// Nothing — open a new chat in the focused leaf.
	const view = newChatView();
	if (view.kind !== 'chat') throw new Error('newChatView must return a chat view');
	store.addTab(focusedId, view);
	const afterAdd = usePaneStore.getState();
	const leaf = findLeaf(afterAdd.root, focusedId);
	const idx = leaf ? leaf.tabs.length - 1 : 0;
	return { leafId: focusedId, tabIdx: idx, threadId: view.sessionId, created: true };
}

// Tree walkers — splits are n-ary in this layout (`children: PaneNode[]`).
import type { LeafNode, PaneNode } from '@/lib/panes/types';

function findLeaf(node: PaneNode, id: string): LeafNode | null {
	if (node.type === 'leaf') return node.id === id ? node : null;
	for (const c of node.children) {
		const hit = findLeaf(c, id);
		if (hit) return hit;
	}
	return null;
}

function collectLeaves(node: PaneNode): LeafNode[] {
	if (node.type === 'leaf') return [node];
	return node.children.flatMap(collectLeaves);
}

/** Mount-once hook for the workspace shell. Subscribes to `pin://routed`
 *  for the lifetime of the app and dispatches the prompt into a chat. */
export function usePinRoutedListener(): void {
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		(async () => {
			unlisten = await listenPinRouted((e) => {
				try {
					const target = resolveOrOpenChatTarget();
					// Focus + switch tab so the prompt lands somewhere visible.
					const store = usePaneStore.getState();
					store.focusPane(target.leafId);
					store.switchTab(target.leafId, target.tabIdx);
					usePendingPrompts.getState().enqueue(target.threadId, formatPinPrompt(e));
				} catch (err) {
					console.error('[pin-routed] dispatch failed', err);
				}
			});
		})();
		return () => unlisten?.();
	}, []);
}
