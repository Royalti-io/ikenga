import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = new Map<string, string>();
let tauriAvailable = true;

vi.mock('@/lib/tauri-cmd', () => ({
	settingsGet: vi.fn(async (key: string) => {
		if (!tauriAvailable) throw new Error('tauri unavailable');
		return kvStore.get(key) ?? null;
	}),
	settingsSet: vi.fn(async (key: string, value: string) => {
		if (!tauriAvailable) throw new Error('tauri unavailable');
		kvStore.set(key, value);
	}),
}));

// Node test env has no DOM — fake localStorage + window so the resolver's
// fallback path is exercisable.
const lsStore = new Map<string, string>();
const fakeLocalStorage = {
	getItem: (k: string) => lsStore.get(k) ?? null,
	setItem: (k: string, v: string) => {
		lsStore.set(k, v);
	},
	removeItem: (k: string) => {
		lsStore.delete(k);
	},
	clear: () => lsStore.clear(),
	key: (i: number) => Array.from(lsStore.keys())[i] ?? null,
	get length() {
		return lsStore.size;
	},
} as unknown as Storage;

vi.stubGlobal('window', { localStorage: fakeLocalStorage });
vi.stubGlobal('localStorage', fakeLocalStorage);

import {
	__resetDefaultEngineCacheForTests,
	bootDefaultChatAdapterId,
	CHAT_ENGINE_LOCAL_STORAGE_KEY,
	currentDefaultEngineId,
	DEFAULT_ENGINE_KV_KEY,
	defaultChatAdapterId,
	setDefaultEngineId,
} from './default-adapter';

beforeEach(() => {
	kvStore.clear();
	tauriAvailable = true;
	localStorage.clear();
	__resetDefaultEngineCacheForTests();
});

describe('defaultChatAdapterId', () => {
	it("defaults to 'acp' when nothing is set", () => {
		expect(defaultChatAdapterId()).toBe('acp');
	});

	it("maps a legacy 'cli' localStorage value to 'cli'", () => {
		localStorage.setItem(CHAT_ENGINE_LOCAL_STORAGE_KEY, 'cli');
		expect(defaultChatAdapterId()).toBe('cli');
	});

	it("maps the cached engineId from settings_kv ('cli' → 'cli')", async () => {
		kvStore.set(DEFAULT_ENGINE_KV_KEY, JSON.stringify('cli'));
		await bootDefaultChatAdapterId();
		expect(defaultChatAdapterId()).toBe('cli');
	});

	it('treats unknown engineIds (e.g. claude-code) as the acp default', async () => {
		kvStore.set(DEFAULT_ENGINE_KV_KEY, JSON.stringify('claude-code'));
		await bootDefaultChatAdapterId();
		expect(defaultChatAdapterId()).toBe('acp');
	});
});

describe('bootDefaultChatAdapterId migration', () => {
	it('copies the legacy localStorage value into settings_kv on first boot', async () => {
		localStorage.setItem(CHAT_ENGINE_LOCAL_STORAGE_KEY, 'cli');
		await bootDefaultChatAdapterId();
		expect(kvStore.get(DEFAULT_ENGINE_KV_KEY)).toBe(JSON.stringify('cli'));
		expect(currentDefaultEngineId()).toBe('cli');
	});

	it('only migrates once — second boot leaves settings_kv untouched', async () => {
		localStorage.setItem(CHAT_ENGINE_LOCAL_STORAGE_KEY, 'cli');
		await bootDefaultChatAdapterId();
		__resetDefaultEngineCacheForTests();

		// User clears settings_kv via "reset" but the migration guard stays.
		kvStore.delete(DEFAULT_ENGINE_KV_KEY);
		localStorage.setItem(CHAT_ENGINE_LOCAL_STORAGE_KEY, 'cli');

		await bootDefaultChatAdapterId();
		expect(kvStore.get(DEFAULT_ENGINE_KV_KEY)).toBeUndefined();
		expect(currentDefaultEngineId()).toBeNull();
	});

	it('falls through cleanly when Tauri is unavailable', async () => {
		tauriAvailable = false;
		localStorage.setItem(CHAT_ENGINE_LOCAL_STORAGE_KEY, 'cli');
		await bootDefaultChatAdapterId();
		// Cache untouched, but localStorage fallback still drives the resolver.
		expect(currentDefaultEngineId()).toBeNull();
		expect(defaultChatAdapterId()).toBe('cli');
	});
});

describe('setDefaultEngineId', () => {
	it('updates the cache and writes through to settings_kv', async () => {
		await setDefaultEngineId('claude-code');
		expect(currentDefaultEngineId()).toBe('claude-code');
		expect(kvStore.get(DEFAULT_ENGINE_KV_KEY)).toBe(JSON.stringify('claude-code'));
	});

	it('null clears the explicit choice in both cache and settings_kv', async () => {
		await setDefaultEngineId('claude-code');
		await setDefaultEngineId(null);
		expect(currentDefaultEngineId()).toBeNull();
		expect(kvStore.get(DEFAULT_ENGINE_KV_KEY)).toBe(JSON.stringify(null));
	});
});
