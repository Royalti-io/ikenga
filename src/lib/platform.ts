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

/**
 * Default interactive-shell argv for a fresh terminal pane. Windows ships
 * `bash.exe` as a WSL launcher (`C:\Windows\System32\bash.exe`) which fails
 * loudly when WSL isn't installed / is misconfigured, so we never default to
 * it there — prefer PowerShell, which is on every supported Windows version.
 */
export function defaultShellArgv(): string[] {
	if (isWindows) {
		return ['powershell.exe', '-NoLogo'];
	}
	return ['bash', '-l'];
}

/** Human-readable label for the default shell, used in menus / tab titles. */
export function defaultShellLabel(): string {
	return isWindows ? 'powershell' : 'bash';
}
