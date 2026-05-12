// Lightweight platform detection. Tauri also provides `@tauri-apps/plugin-os`
// for richer queries, but for menu wiring + shortcut display this is enough.

export const isMac =
	typeof navigator !== 'undefined' && navigator.platform.toLowerCase().startsWith('mac');

export const isWindows =
	typeof navigator !== 'undefined' && navigator.platform.toLowerCase().startsWith('win');

export const isLinux =
	typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('linux');

/** Display the platform-correct mod-key glyph for shortcut hints. */
export const modKey = isMac ? '⌘' : 'Ctrl';
