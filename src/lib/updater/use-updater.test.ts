/**
 * The updater's install step must NOT relaunch on its own.
 *
 * On Linux the bundle installs through an elevated pkexec/dpkg step the
 * download callback can't see, so an immediate auto-relaunch tears the window
 * down mid-flow and reads as a crash even though the install succeeded (the
 * download bar freezes, then the window vanishes). The fix splits install from
 * relaunch: `install()` holds at an `installed` state, and the UI surfaces a
 * deliberate `restart()`.
 *
 * This holds on EVERY path — including the opt-in background auto-install.
 * A relaunch the user didn't ask for throws away whatever is live in terminals
 * and pkg panes, so `restartApp` is reachable only through `restart()`.
 *
 * These tests pin that contract at the hook boundary.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdate = vi.fn();
const installUpdate = vi.fn(async () => {});
const restartApp = vi.fn(async () => {});

vi.mock('@/lib/updater/updater', () => ({
	checkForUpdate: () => checkForUpdate(),
	installUpdate: (...args: unknown[]) => installUpdate(...(args as [])),
	restartApp: () => restartApp(),
}));

import { useUpdater } from './use-updater';

const FAKE_UPDATE = {
	version: '0.6.0',
	notes: 'notes',
	date: undefined,
	currentVersion: '0.5.0',
	handle: {} as never,
};

beforeEach(() => {
	checkForUpdate.mockReset().mockResolvedValue(FAKE_UPDATE);
	installUpdate.mockReset().mockResolvedValue(undefined);
	restartApp.mockReset().mockResolvedValue(undefined);
});

// autoPoll off so the only check() is the boot one; enabled default true.
function mount() {
	return renderHook(() => useUpdater({ autoPoll: false }));
}

describe('useUpdater — install / restart split', () => {
	it('install() installs but does NOT relaunch; holds at the installed state', async () => {
		const { result } = mount();
		await waitFor(() => expect(result.current.available).toEqual(FAKE_UPDATE));

		await act(async () => {
			await result.current.install();
		});

		expect(installUpdate).toHaveBeenCalledTimes(1);
		// The whole point: no relaunch out from under the user.
		expect(restartApp).not.toHaveBeenCalled();
		expect(result.current.installed).toBe(true);
		expect(result.current.installing).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it('restart() is what triggers the relaunch', async () => {
		const { result } = mount();
		await waitFor(() => expect(result.current.available).toEqual(FAKE_UPDATE));
		await act(async () => {
			await result.current.install();
		});
		expect(restartApp).not.toHaveBeenCalled();

		await act(async () => {
			await result.current.restart();
		});
		expect(restartApp).toHaveBeenCalledTimes(1);
	});

	it('install() takes no opt-in to relaunch — the auto-install path can only reach `installed`', async () => {
		const { result } = mount();
		await waitFor(() => expect(result.current.available).toEqual(FAKE_UPDATE));

		// The background auto-install path calls the exact same install() the
		// banner button does. Passing anything must not resurrect a relaunch.
		await act(async () => {
			await (result.current.install as (opts?: unknown) => Promise<void>)({ autoRestart: true });
		});

		expect(installUpdate).toHaveBeenCalledTimes(1);
		expect(restartApp).not.toHaveBeenCalled();
		expect(result.current.installed).toBe(true);
	});

	it('a failed install surfaces the error and does NOT relaunch', async () => {
		installUpdate.mockRejectedValueOnce(new Error('download died'));
		const { result } = mount();
		await waitFor(() => expect(result.current.available).toEqual(FAKE_UPDATE));

		await act(async () => {
			await result.current.install();
		});

		expect(result.current.error).toBe('download died');
		expect(result.current.installed).toBe(false);
		expect(result.current.installing).toBe(false);
		expect(restartApp).not.toHaveBeenCalled();
	});
});
