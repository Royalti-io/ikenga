// Phase 9: unit tests for the pure-function focus-suppression policy.
//
// The full bridge ties into Tauri's `listen()` + `@tauri-apps/plugin-notification`
// which aren't available under vitest; we exercise the pure dispatch matrix
// here and lean on the iyke smoke harness (`ikengaAcpNotifyWatch`) for the
// integration coverage.

import { describe, expect, it } from 'vitest';

import { decideDispatch } from './acp-notify-bridge';
import type { AcpNotifyPayload } from '@/lib/tauri-cmd';

const basePayload = (overrides: Partial<AcpNotifyPayload> = {}): AcpNotifyPayload => ({
	threadId: 't_1',
	title: 'Test',
	body: 'body',
	kind: 'notification',
	...overrides,
});

describe('decideDispatch', () => {
	it('suppresses both when window is focused on the same thread', () => {
		// The matrix's quiet quadrant: user is staring at the thread, the
		// in-UI PermissionDialog / notification surface is already up,
		// no OS popup needed.
		const r = decideDispatch(basePayload({ threadId: 't_1' }), {
			windowFocused: true,
			focusedThreadId: 't_1',
		});
		expect(r.bumpBadge).toBe(false);
		expect(r.fireOsNotification).toBe(false);
	});

	it('fires OS + badge when window is focused on a different thread', () => {
		// User is deep in another conversation; they need to be told
		// something pinged for thread 't_1'.
		const r = decideDispatch(basePayload({ threadId: 't_1' }), {
			windowFocused: true,
			focusedThreadId: 't_other',
		});
		expect(r.bumpBadge).toBe(true);
		expect(r.fireOsNotification).toBe(true);
	});

	it('fires OS + badge when window is unfocused (same thread)', () => {
		// App in background; user can't see the in-UI dialog so the OS
		// notification IS the surface.
		const r = decideDispatch(basePayload({ threadId: 't_1' }), {
			windowFocused: false,
			focusedThreadId: 't_1',
		});
		expect(r.bumpBadge).toBe(true);
		expect(r.fireOsNotification).toBe(true);
	});

	it('fires OS + badge when window is unfocused and no active thread', () => {
		const r = decideDispatch(basePayload({ threadId: 't_1' }), {
			windowFocused: false,
			focusedThreadId: null,
		});
		expect(r.bumpBadge).toBe(true);
		expect(r.fireOsNotification).toBe(true);
	});

	it('does not treat null focusedThreadId as a match for any thread', () => {
		// Regression guard: an early version of the logic accidentally
		// treated `null === payload.threadId` as truthy when the payload
		// id was also nullish. Tighten to explicit string equality.
		const r = decideDispatch(basePayload({ threadId: '' }), {
			windowFocused: true,
			focusedThreadId: null,
		});
		expect(r.fireOsNotification).toBe(true);
	});

	it('treats permissionRequest kind the same as notification', () => {
		// Phase 9 doesn't (yet) differentiate per-kind in the dispatch
		// decision — both are user-attention events. Lock this in so a
		// future kind-aware tweak is a deliberate change.
		const r = decideDispatch(basePayload({ kind: 'permissionRequest' }), {
			windowFocused: true,
			focusedThreadId: 't_1',
		});
		expect(r.bumpBadge).toBe(false);
		expect(r.fireOsNotification).toBe(false);
	});
});
