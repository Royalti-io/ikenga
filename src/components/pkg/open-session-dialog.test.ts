// Unit tests for the openSessionDialog core (WP-27 / G-SESSION-DIALOG).
// Covers:
//   - the request/settle store contract (one-shot, second request cancels the
//     first so the prior verb caller never dangles)
//   - the source-stamp prefix matches WP-22's `[via: groundwork/<source>]`
//   - the default source ('unknown') when none is passed
//   - args round-trip into `pending.args` unchanged (so the dialog host can
//     pre-fill cleanly)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	applySourceStampToArgs,
	openSessionDialog,
	useOpenSessionDialogStore,
} from './open-session-dialog';

beforeEach(() => {
	useOpenSessionDialogStore.setState({ pending: null });
});

afterEach(() => {
	useOpenSessionDialogStore.setState({ pending: null });
});

describe('applySourceStampToArgs', () => {
	it('prefixes the initial prompt with [via: groundwork/<source>]', () => {
		const out = applySourceStampToArgs({
			initialPrompt: 'Build the brief',
			source: 'board',
		});
		expect(out.initialPrompt).toBe('[via: groundwork/board]\n\nBuild the brief');
	});

	it("defaults the source to 'unknown' when omitted", () => {
		const out = applySourceStampToArgs({ initialPrompt: 'hi' });
		expect(out.initialPrompt).toBe('[via: groundwork/unknown]\n\nhi');
	});

	it('emits just the stamp when no prompt is passed', () => {
		const out = applySourceStampToArgs({ source: 'palette' });
		expect(out.initialPrompt).toBe('[via: groundwork/palette]');
	});

	it('preserves the other args verbatim', () => {
		const out = applySourceStampToArgs({
			initialPrompt: 'x',
			engineId: 'com.ikenga.engine-gemini',
			sessionKind: 'terminal',
			cwd: '/tmp/proj',
			title: 'WP-09',
			source: 'wp-card',
		});
		expect(out.engineId).toBe('com.ikenga.engine-gemini');
		expect(out.sessionKind).toBe('terminal');
		expect(out.cwd).toBe('/tmp/proj');
		expect(out.title).toBe('WP-09');
		expect(out.source).toBe('wp-card');
	});
});

describe('openSessionDialog store contract', () => {
	it('stamps and stashes the args under pending; resolves on settle', async () => {
		const promise = openSessionDialog({
			initialPrompt: 'Build it',
			engineId: 'com.ikenga.engine-claude-code',
			sessionKind: 'chat',
			source: 'board',
		});

		const pending = useOpenSessionDialogStore.getState().pending;
		expect(pending).not.toBeNull();
		expect(pending?.args.initialPrompt).toBe('[via: groundwork/board]\n\nBuild it');
		expect(pending?.args.engineId).toBe('com.ikenga.engine-claude-code');
		expect(pending?.args.sessionKind).toBe('chat');

		useOpenSessionDialogStore
			.getState()
			.settle({ ok: true, kind: 'chat', threadId: 'thread-9' });

		await expect(promise).resolves.toEqual({
			ok: true,
			kind: 'chat',
			threadId: 'thread-9',
		});

		// Pending cleared after settle so subsequent opens start fresh.
		expect(useOpenSessionDialogStore.getState().pending).toBeNull();
	});

	it('terminal result rounds through the same shape', async () => {
		const promise = openSessionDialog({ initialPrompt: 'pwd', sessionKind: 'terminal' });
		useOpenSessionDialogStore
			.getState()
			.settle({ ok: true, kind: 'terminal', paneId: 'pane-3' });
		await expect(promise).resolves.toEqual({
			ok: true,
			kind: 'terminal',
			paneId: 'pane-3',
		});
	});

	it('cancelled result rounds through cleanly', async () => {
		const promise = openSessionDialog({ initialPrompt: 'never sent' });
		useOpenSessionDialogStore.getState().settle({ ok: false, reason: 'cancelled' });
		await expect(promise).resolves.toEqual({ ok: false, reason: 'cancelled' });
	});

	it('cancels an in-flight request when a second one arrives so the first promise never dangles', async () => {
		const first = openSessionDialog({ initialPrompt: 'first' });
		const second = openSessionDialog({ initialPrompt: 'second' });

		// The first promise settles immediately with `cancelled` (the
		// second request stole the slot).
		await expect(first).resolves.toEqual({ ok: false, reason: 'cancelled' });

		// The store now points at the second request.
		expect(useOpenSessionDialogStore.getState().pending?.args.initialPrompt).toBe(
			'[via: groundwork/unknown]\n\nsecond'
		);

		useOpenSessionDialogStore
			.getState()
			.settle({ ok: true, kind: 'chat', threadId: 'thread-2' });
		await expect(second).resolves.toEqual({
			ok: true,
			kind: 'chat',
			threadId: 'thread-2',
		});
	});

	it('settle is a no-op when nothing is pending', () => {
		// Pre-condition: idle.
		expect(useOpenSessionDialogStore.getState().pending).toBeNull();
		expect(() =>
			useOpenSessionDialogStore.getState().settle({ ok: false, reason: 'cancelled' })
		).not.toThrow();
	});
});
