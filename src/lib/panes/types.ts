export type PaneId = string;

export type MiniAppName =
  | 'storyboard'
  | 'video-engine'
  | 'hyperframes'
  | 'canvas-design'
  | 'image-generator';

export type PaneView = (
  | { kind: 'route'; path: string }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'artifact'; path: string }
  | { kind: 'mini-app'; name: MiniAppName }
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
