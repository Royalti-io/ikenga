// React hook that owns the updater check/install state. Polls the endpoint
// on app boot + every 6h, and exposes:
//   - available: UpdateInfo | null
//   - installing: boolean, bytesDownloaded / totalBytes for progress
//   - install(): kicks off downloadAndInstall + relaunch
//   - check(): manual re-check (e.g. "Check now" on the About page)
//   - lastCheckedAt: epoch ms of the last successful check
//   - checking: true while a check is in flight
//
// Hook is intended to be used at multiple call sites (banner + About page +
// mission-control tile) — each instance maintains its own state, but the
// underlying Tauri command is the same global. The 6h auto-check fires from
// the banner instance mounted in workspace.tsx; pass `{ autoPoll: false }`
// from secondary call sites so only the banner owns the timer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdate, installAndRelaunch, type UpdateInfo } from '@/lib/updater/updater';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export type UpdaterState = {
	available: UpdateInfo | null;
	installing: boolean;
	bytesDownloaded: number;
	totalBytes: number | null;
	error: string | null;
	checking: boolean;
	lastCheckedAt: number | null;
	check: () => Promise<void>;
	install: () => Promise<void>;
};

export interface UseUpdaterOptions {
	/** Default true. Pass false to skip the 6h interval timer (e.g. secondary
	 *  call sites where another instance already owns the polling). */
	autoPoll?: boolean;
	/** Default true. Pass false to suppress automatic checks entirely — no
	 *  boot check and no interval. The manual `check()` still works (the About
	 *  page's "Check now" button). Driven by the `updates.autoCheck` setting. */
	enabled?: boolean;
}

export function useUpdater(options?: UseUpdaterOptions): UpdaterState {
	const autoPoll = options?.autoPoll ?? true;
	const enabled = options?.enabled ?? true;
	const [available, setAvailable] = useState<UpdateInfo | null>(null);
	const [installing, setInstalling] = useState(false);
	const [bytesDownloaded, setBytesDownloaded] = useState(0);
	const [totalBytes, setTotalBytes] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			const info = await checkForUpdate();
			setAvailable(info);
			setLastCheckedAt(Date.now());
		} finally {
			setChecking(false);
		}
	}, []);

	const install = useCallback(async () => {
		if (!available) return;
		setInstalling(true);
		setError(null);
		try {
			await installAndRelaunch(available, (b, t) => {
				setBytesDownloaded(b);
				setTotalBytes(t);
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setInstalling(false);
		}
	}, [available]);

	const intervalRef = useRef<number | null>(null);
	useEffect(() => {
		if (!enabled) return;
		void check();
		if (autoPoll) {
			intervalRef.current = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
		}
		return () => {
			if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
		};
	}, [check, autoPoll, enabled]);

	return {
		available,
		installing,
		bytesDownloaded,
		totalBytes,
		error,
		checking,
		lastCheckedAt,
		check,
		install,
	};
}
