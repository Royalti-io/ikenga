// Thin typed wrapper over @tauri-apps/plugin-updater. The plugin's check()
// hits the endpoint declared in tauri.conf.json plugins.updater.endpoints
// (the GitHub Releases latest.json), verifies the bundle sig against the
// embedded minisign pubkey, and exposes downloadAndInstall() + relaunch().

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateInfo = {
	version: string;
	notes?: string;
	date?: string;
	currentVersion: string;
	/** Internal handle used to start the install. */
	handle: Update;
};

/**
 * Check the configured endpoint for a newer release. Returns null when the
 * current version is up to date, or when the check fails (network down,
 * endpoint 404, sig mismatch — log + degrade gracefully).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	try {
		const update = await check();
		if (!update) return null;
		return {
			version: update.version,
			notes: update.body,
			date: update.date,
			currentVersion: update.currentVersion,
			handle: update,
		};
	} catch (err) {
		console.warn('[updater] check failed:', err);
		return null;
	}
}

/**
 * Download + install the update bundle. Does NOT relaunch — see `restartApp`.
 *
 * The relaunch is deliberately a separate step. On Linux especially, the
 * install applies through an elevated `pkexec`/`dpkg` step whose progress the
 * download callback can't see, so the byte-count bar freezes near the end;
 * if we then relaunch immediately the window tears down mid-flow and the whole
 * thing reads as a crash — even though the install actually succeeded. Letting
 * the UI hold at an explicit "installed — restart to finish" state before
 * calling `restartApp()` keeps the restart a deliberate, visible act.
 *
 * `onProgress` reports total bytes downloaded so the UI can render a bar.
 * Tauri reports `started` / `progress` / `finished` events; we collapse
 * them to a running byte count.
 */
export async function installUpdate(
	info: UpdateInfo,
	onProgress?: (bytesDownloaded: number, totalBytes: number | null) => void
): Promise<void> {
	let downloaded = 0;
	let total: number | null = null;
	await info.handle.downloadAndInstall((event) => {
		switch (event.event) {
			case 'Started':
				total = event.data.contentLength ?? null;
				downloaded = 0;
				break;
			case 'Progress':
				downloaded += event.data.chunkLength;
				onProgress?.(downloaded, total);
				break;
			case 'Finished':
				onProgress?.(total ?? downloaded, total);
				break;
		}
	});
}

/** Relaunch to complete an already-installed update. Kept separate from
 * `installUpdate` so the caller can gate it behind a user click (or the
 * opt-in auto-install path can chain it explicitly). */
export async function restartApp(): Promise<void> {
	await relaunch();
}
