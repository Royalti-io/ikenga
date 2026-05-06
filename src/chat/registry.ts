/**
 * Tiny adapter registry. v1 only registers `ClaudeCliAdapter`; the surface
 * exists so future adapters drop in without touching call sites.
 */

import type { ChatAdapter } from './adapter';

const registry = new Map<string, ChatAdapter>();

export function registerAdapter(adapter: ChatAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): ChatAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`adapter not registered: ${id}`);
  return a;
}

export function listAdapters(): ChatAdapter[] {
  return Array.from(registry.values());
}

export function hasAdapter(id: string): boolean {
  return registry.has(id);
}
