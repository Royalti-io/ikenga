// React hook that owns the updater check/install state. Polls the endpoint
// on app boot + every 6h, and exposes:
//   - available: UpdateInfo | null
//   - installing: boolean, bytesDownloaded / totalBytes for progress
//   - install(): kicks off downloadAndInstall + relaunch
//
// Render however suits the shell. The default integration is
// `src/shell/updater-banner.tsx`, which appears in workspace.tsx.

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdate, installAndRelaunch, type UpdateInfo } from '@/lib/updater/updater';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export type UpdaterState = {
	available: UpdateInfo | null;
	installing: boolean;
	bytesDownloaded: number;
	totalBytes: number | null;
	error: string | null;
	check: () => Promise<void>;
	install: () => Promise<void>;
};

export function useUpdater(): UpdaterState {
	const [available, setAvailable] = useState<UpdateInfo | null>(null);
	const [installing, setInstalling] = useState(false);
	const [bytesDownloaded, setBytesDownloaded] = useState(0);
	const [totalBytes, setTotalBytes] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	const check = useCallback(async () => {
		const info = await checkForUpdate();
		setAvailable(info);
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
		void check();
		intervalRef.current = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
		return () => {
			if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
		};
	}, [check]);

	return {
		available,
		installing,
		bytesDownloaded,
		totalBytes,
		error,
		check,
		install,
	};
}
