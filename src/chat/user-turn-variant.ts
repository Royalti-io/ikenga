/**
 * User-turn rendering style preference.
 *
 * Source of truth is `settings_kv` (`shell.chat.userMessageStyle`).
 * Four variants live in `design/shell/chat-redesign/2026-05-18-user-
 * turn-variants.html`:
 *
 *   - `baseline` — right-aligned text + bottom hairline. Calmest.
 *   - `bubble`   — filled rounded container with clipped bottom-left
 *                  corner. Most familiar "chat" affordance.
 *   - `accent`   — 2px ember left border + bottom hairline. Editorial
 *                  blockquote feel.
 *   - `frame`    — 1px hairline outline, 2px radius, no fill.
 *
 * The reader (`Thread`) renders the chosen variant via a className on
 * the user-turn wrapper. CSS in `styles.css` defines `.utv-baseline`
 * through `.utv-frame`. A `localStorage` mirror keeps the synchronous
 * `loadUserTurnVariant()` accessor honest in test / Tauri-unavailable
 * contexts.
 */

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';

export type UserTurnVariant = 'baseline' | 'bubble' | 'accent' | 'frame';

export const DEFAULT_USER_TURN_VARIANT: UserTurnVariant = 'baseline';
export const USER_TURN_VARIANTS: ReadonlyArray<{
	id: UserTurnVariant;
	label: string;
	description: string;
}> = [
	{
		id: 'baseline',
		label: 'Baseline',
		description: 'Right-aligned text with a hairline underneath. Calmest.',
	},
	{
		id: 'bubble',
		label: 'Bubble',
		description: 'Filled rounded container with a clipped bottom-left corner.',
	},
	{
		id: 'accent',
		label: 'Left accent',
		description: 'Ember-colored left border, editorial blockquote feel.',
	},
	{
		id: 'frame',
		label: 'Hairline frame',
		description: 'Thin outline, no fill — paper/letterpress weight.',
	},
];

const KV_KEY = 'shell.chat.userMessageStyle';
const LOCAL_STORAGE_KEY = 'ikenga.chat.userMessageStyle';

let cached: UserTurnVariant | null = null;
const subscribers = new Set<(v: UserTurnVariant) => void>();

function readLocalStorage(): UserTurnVariant | null {
	try {
		if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
		const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (!raw) return null;
		return parseVariant(raw);
	} catch {
		return null;
	}
}

function parseVariant(raw: string): UserTurnVariant | null {
	try {
		const v = JSON.parse(raw);
		return isVariant(v) ? v : null;
	} catch {
		return isVariant(raw) ? raw : null;
	}
}

function isVariant(v: unknown): v is UserTurnVariant {
	return v === 'baseline' || v === 'bubble' || v === 'accent' || v === 'frame';
}

/** Synchronous accessor. Returns the cached value if hydrate has run,
 *  otherwise falls back to localStorage, otherwise the default. */
export function loadUserTurnVariant(): UserTurnVariant {
	return cached ?? readLocalStorage() ?? DEFAULT_USER_TURN_VARIANT;
}

/** Hydrate the cache from `settings_kv` on boot. Best-effort: if Tauri
 *  is unavailable the cache stays empty and synchronous reads fall
 *  through to localStorage on every call. */
export async function bootUserTurnVariant(): Promise<void> {
	try {
		const raw = await settingsGet(KV_KEY);
		const parsed = raw ? parseVariant(raw) : null;
		if (parsed) {
			cached = parsed;
			try {
				localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(parsed));
			} catch {
				// noop — Tauri-only env, no localStorage
			}
		}
	} catch {
		// Tauri unavailable — keep cache empty.
	}
}

export async function setUserTurnVariant(variant: UserTurnVariant): Promise<void> {
	cached = variant;
	try {
		localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(variant));
	} catch {
		// noop
	}
	try {
		await settingsSet(KV_KEY, JSON.stringify(variant));
	} catch {
		// noop — localStorage mirror is enough in dev/test
	}
	for (const fn of subscribers) fn(variant);
}

/** Subscribe to writes. The Thread renderer uses this so a Settings-page
 *  change applies live without a reload. Returns an unsubscribe fn. */
export function subscribeUserTurnVariant(fn: (v: UserTurnVariant) => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

/** Test-only — reset the in-memory cache. Not exported from the public
 *  chat barrel. */
export function __resetUserTurnVariantCacheForTests(): void {
	cached = null;
	subscribers.clear();
}
