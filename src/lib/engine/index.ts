// Engine singleton for the shell.
//
// The engine kernel will eventually load engines dynamically from installed
// pkgs, but until that lands we eagerly construct the Claude Code engine
// here so the rest of the shell can `import { engine } from '@/lib/engine'`
// and call it like any other service. Tests can override by importing
// `createEngineFromBridge` and passing a mock `HostBridge`.
//
// Phase 10 — alongside the legacy `Engine` singleton we now expose an
// `AcpEngine` instance. The chat adapter layer reaches for `getAcpEngine()`;
// other consumers (sales, content) that still target the legacy contract
// stay on `getEngine()` until Phase 11 retires it.

import {
	createAcpEngine,
	createEngine,
	type AcpHost,
	type HostBridge,
} from '@ikenga/pkg-engine-claude-code';
import type { AcpEngine, Engine } from '@ikenga/contract/engine';

import { createShellAcpHost, createShellHostBridge } from './host-bridge';

export { createShellHostBridge, createShellAcpHost } from './host-bridge';
export { chatEventToEngineEvent } from './host-bridge';

/**
 * Construct an `Engine` from a caller-supplied `HostBridge`. Exists so
 * unit tests can inject mocks without touching the Tauri command layer.
 */
export function createEngineFromBridge(host: HostBridge): Engine {
	return createEngine(host);
}

/**
 * Construct an `AcpEngine` from a caller-supplied `AcpHost`. Mirrors
 * `createEngineFromBridge` for the ACP-shaped surface — tests inject a fake
 * `AcpHost`; production wires `createShellAcpHost()`.
 */
export function createAcpEngineFromHost(host: AcpHost): AcpEngine {
	return createAcpEngine(host);
}

let _engine: Engine | null = null;
let _acpEngine: AcpEngine | null = null;

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

/**
 * Phase 10 — lazily-initialised ACP-shaped engine. Used by the new
 * `acp` chat adapter. Same lazy-singleton rationale as `getEngine`.
 */
export function getAcpEngine(): AcpEngine {
	if (!_acpEngine) {
		_acpEngine = createAcpEngine(createShellAcpHost());
	}
	return _acpEngine;
}
