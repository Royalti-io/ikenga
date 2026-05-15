/**
 * Chat adapter default resolution.
 *
 * Lives in its own file (vs. `index.ts`) so `hooks.ts` and adapter modules
 * can import it without forming a circular dependency through the public
 * chat barrel.
 *
 * Source of truth is `settings_kv` (`shell.defaultEngineId`). A one-shot
 * migration copies the legacy `localStorage.ikenga_chat_engine` value
 * through on first boot so users coming from the previous build don't
 * silently reset to the platform default. The resolver stays synchronous —
 * `bootDefaultChatAdapterId()` hydrates the cache at app start; subsequent
 * setter writes update both the cache and `settings_kv`.
 *
 * Mapped values:
 *   - 'legacy' / 'cli' → 'cli' (legacy `ClaudeCliAdapter`)
 *   - any other string / null → 'acp' (default `AcpAdapter`)
 *
 * Existing threads keep whatever `adapterId` was persisted in SQLite when
 * they were created. This helper only governs new-thread defaults and any
 * call site that wants to mirror the user's current preference.
 */

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';

export const CHAT_ENGINE_LOCAL_STORAGE_KEY = 'ikenga_chat_engine';
export const DEFAULT_ENGINE_KV_KEY = 'shell.defaultEngineId';
const MIGRATED_KV_KEY = 'shell.defaultEngineId.migrated';

export type ChatAdapterId = 'acp' | 'cli';

let cachedEngineId: string | null = null;

function readLocalStorage(): string | null {
	try {
		if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
			return localStorage.getItem(CHAT_ENGINE_LOCAL_STORAGE_KEY);
		}
	} catch {
		// Restricted storage — treat as absent.
	}
	return null;
}

function parseEngineId(raw: string | null): string | null {
	if (raw == null) return null;
	// Stored as JSON (matches the rest of settings_kv conventions). Tolerate
	// a raw string fallback so the legacy localStorage path also flows here.
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'string' ? parsed : null;
	} catch {
		return raw;
	}
}

export function defaultChatAdapterId(): ChatAdapterId {
	const id = cachedEngineId ?? readLocalStorage();
	if (id === 'legacy' || id === 'cli') return 'cli';
	return 'acp';
}

/** Synchronous accessor for the raw engineId — non-mapped, lets the
 *  onboarding step display the user's current durable choice. */
export function currentDefaultEngineId(): string | null {
	return cachedEngineId;
}

/** Boot-time hydration. Reads `settings_kv` once; if empty and a legacy
 *  localStorage value exists, migrates it through and stamps the guard
 *  key so future boots skip the copy. Call from `main.tsx` alongside the
 *  other `hydrate*FromRust` paths. Safe to call when Tauri is unavailable
 *  (test env) — the resolver falls back to localStorage on its own. */
export async function bootDefaultChatAdapterId(): Promise<void> {
	try {
		const existing = await settingsGet(DEFAULT_ENGINE_KV_KEY);
		const parsed = parseEngineId(existing);
		if (parsed) {
			cachedEngineId = parsed;
			return;
		}
		const migrated = await settingsGet(MIGRATED_KV_KEY);
		if (migrated) {
			cachedEngineId = null;
			return;
		}
		const legacy = readLocalStorage();
		if (legacy) {
			await settingsSet(DEFAULT_ENGINE_KV_KEY, JSON.stringify(legacy));
			cachedEngineId = legacy;
		}
		await settingsSet(MIGRATED_KV_KEY, JSON.stringify(true));
	} catch {
		// Tauri unavailable — leave the cache empty and let the resolver
		// fall through to localStorage on every call.
	}
}

/** Persist the user's chosen engine to `settings_kv` and update the cache
 *  so the next `defaultChatAdapterId()` reflects it immediately. Pass
 *  `null` to clear the explicit choice. */
export async function setDefaultEngineId(engineId: string | null): Promise<void> {
	cachedEngineId = engineId;
	try {
		await settingsSet(DEFAULT_ENGINE_KV_KEY, JSON.stringify(engineId));
	} catch {
		// Tauri unavailable — localStorage still serves the legacy fallback
		// path so the user's selection isn't lost in dev / test.
	}
}

/** Test-only — reset the in-memory cache so each test starts from a
 *  predictable state. Not exported from the public chat barrel. */
export function __resetDefaultEngineCacheForTests(): void {
	cachedEngineId = null;
}
