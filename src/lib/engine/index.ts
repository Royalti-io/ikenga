// Engine singleton for the shell.
//
// The engine kernel will eventually load engines dynamically from installed
// pkgs, but until that lands we eagerly construct the Claude Code engine
// here so the rest of the shell can `import { engine } from '@/lib/engine'`
// and call it like any other service. Tests can override by importing
// `createEngineFromBridge` and passing a mock `HostBridge`.

import { createEngine, type HostBridge } from "@ikenga/pkg-engine-claude-code";
import type { Engine } from "@ikenga/contract/engine";

import { createShellHostBridge } from "./host-bridge";

export { createShellHostBridge } from "./host-bridge";
export { chatEventToEngineEvent } from "./host-bridge";

/**
 * Construct an `Engine` from a caller-supplied `HostBridge`. Exists so
 * unit tests can inject mocks without touching the Tauri command layer.
 */
export function createEngineFromBridge(host: HostBridge): Engine {
  return createEngine(host);
}

let _engine: Engine | null = null;

/**
 * Lazily-initialised default engine instance. Construction is deferred so
 * importing this module never triggers Tauri calls — the bridge itself
 * doesn't call `invoke()` until one of its methods runs, but keeping the
 * singleton lazy makes module-graph reasoning easier (and gives test code
 * a chance to call `createEngineFromBridge` first).
 */
export function getEngine(): Engine {
  if (!_engine) {
    _engine = createEngine(createShellHostBridge());
  }
  return _engine;
}
