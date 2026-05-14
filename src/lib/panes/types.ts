export type PaneId = string;

// Pane view kinds. `mini-app` was removed in the strip-down — media tooling
// (storyboard/video-engine/hyperframes/canvas/image-generator) now lives in
// app pkgs that mount via /pkg/$pkgId/* routes.
export type PaneView = (
	| { kind: 'route'; path: string }
	| { kind: 'terminal'; sessionId: string }
	| { kind: 'chat'; sessionId: string }
	| { kind: 'artifact'; path: string }
	| { kind: 'scratchpad'; scope: string; name: string }
) & { pinned?: boolean };

export type PaneDirection = 'horizontal' | 'vertical';

export interface SplitNode {
	type: 'split';
	direction: PaneDirection;
	children: PaneNode[];
	sizes: number[];
}

export interface LeafNode {
	type: 'leaf';
	id: PaneId;
	tabs: PaneView[];
	activeTabIdx: number;
}

export type PaneNode = SplitNode | LeafNode;

export const MAX_LEAVES = 6;
