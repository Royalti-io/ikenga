import type { Pty } from './pty-bridge';

// Module-level PTY registry keyed by terminal session id (= terminal-store
// tab id, also used as pane view sessionId). Lives outside React so PTY
// instances survive component remounts when the surrounding pane tree
// rebuilds.
const registry = new Map<string, Pty>();

export function registerPty(sessionId: string, pty: Pty): void {
	registry.set(sessionId, pty);
}

export function getPty(sessionId: string): Pty | undefined {
	return registry.get(sessionId);
}

export function disposePty(sessionId: string): void {
	const pty = registry.get(sessionId);
	registry.delete(sessionId);
	if (pty) {
		pty.dispose().catch(() => {});
	}
}

export function listPtyIds(): string[] {
	return Array.from(registry.keys());
}
