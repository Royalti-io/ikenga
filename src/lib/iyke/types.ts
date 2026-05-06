// Iyke wire types. These mirror the Rust handlers in
// src-tauri/src/iyke/handlers.rs — keep in sync. The schema_version field
// is the contract: bump it on the Rust side when the response shape
// changes in a non-additive way.

export interface IykeEndpoint {
  url: string;
  token: string;
  port: number;
}

export interface IykeAppInfo {
  pid: number;
  started_at_unix_ms: number;
  identifier: string;
}

export interface IykeShellInfo {
  mode: string | null;
  route: string | null;
  /** Phase 12 PR-E. Null when the FE hasn't pushed yet. */
  panes: IykePanesPayload | null;
}

export interface IykeLeafSummary {
  id: string;
  focused: boolean;
  activeTabIdx: number;
  tabs: Array<{ kind: string; title: string }>;
}

/**
 * Pane-tree wire shape. `tree` is the recursive PaneNode the FE owns —
 * Rust treats it as opaque JSON. `leaves` is a flat DFS-ordered list
 * for clients that don't want to walk the tree (most CLI/MCP cases).
 */
export interface IykePanesPayload {
  leaves: IykeLeafSummary[];
  tree: unknown;
}

export interface IykeStateResponse {
  schema_version: number;
  app: IykeAppInfo;
  shell: IykeShellInfo;
}
