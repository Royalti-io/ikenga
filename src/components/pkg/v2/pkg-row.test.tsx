// Render tests for <PkgRow />. Covers the four action-button shapes
// (registry / outdated / needs-trust / default), and the event-handling
// contract: clicking the row fires onOpen, clicking the action buttons
// fires their callback WITHOUT also firing onOpen.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { PkgRow } from './pkg-row';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';

afterEach(cleanup);

function withQuery(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeRow(overrides: Partial<PkgRowV2> = {}): PkgRowV2 {
	return {
		id: 'com.test.x',
		name: 'Test Pkg',
		version: '0.1.0',
		origin: 'user',
		kind: 'ui',
		state: 'idle',
		enabled: true,
		desc: 'A test pkg',
		installPath: '~/.config/ikenga/pkgs/com.test.x',
		installedAt: 1_700_000_000,
		latest: null,
		scopes: [],
		routes: [],
		sidecars: [],
		trust: null,
		violations: [],
		screenshots: [],
		installed: null,
		manifest: null,
		registryEntry: null,
		...overrides,
	};
}

describe('PkgRow — identity', () => {
	it('renders name, version, and id', () => {
		render(withQuery(<PkgRow row={makeRow()} onOpen={() => {}} />));
		expect(screen.getByText('Test Pkg')).toBeTruthy();
		expect(screen.getByText('v0.1.0')).toBeTruthy();
		expect(screen.getByText('com.test.x')).toBeTruthy();
	});

	it('shows the description when present', () => {
		render(withQuery(<PkgRow row={makeRow({ desc: 'A short blurb' })} onOpen={() => {}} />));
		expect(screen.getByText('A short blurb')).toBeTruthy();
	});
});

describe('PkgRow — action buttons per state', () => {
	it('default state shows Open + a Configure icon button', () => {
		render(withQuery(<PkgRow row={makeRow()} onOpen={() => {}} />));
		expect(screen.getByRole('button', { name: /Open/i })).toBeTruthy();
		expect(screen.getByRole('button', { name: /Configure/i })).toBeTruthy();
	});

	it('registry rows show a single Install button (no Open)', () => {
		render(
			withQuery(
				<PkgRow
					row={makeRow({ origin: 'registry', state: 'not-installed' })}
					onOpen={() => {}}
					onInstall={() => {}}
				/>
			)
		);
		expect(screen.getByRole('button', { name: /Install/i })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Open/i })).toBeNull();
	});

	it('outdated rows show Update + an Open detail icon', () => {
		render(
			withQuery(
				<PkgRow
					row={makeRow({ version: '0.1.0', latest: '0.2.0' })}
					onOpen={() => {}}
					onUpdate={() => {}}
				/>
			)
		);
		expect(screen.getByRole('button', { name: /Update/i })).toBeTruthy();
		expect(screen.getByRole('button', { name: /Open detail/i })).toBeTruthy();
		// "Open" (without "detail") shouldn't appear — Update replaces it.
		expect(screen.queryByRole('button', { name: /^Open$/ })).toBeNull();
	});

	it('needs-trust rows show a single Review button', () => {
		render(
			withQuery(
				<PkgRow
					row={makeRow({
						trust: {
							pkg_id: 'com.test.x',
							version: '0.1.0',
							state: 'needs_approval',
							perms: { shell_execute: [], fs_write_outside_sandbox: [], net: [], vault_keys: [] },
							last_granted_at_ms: null,
							change_reason: null,
							auto_trusted: false,
						},
					})}
					onOpen={() => {}}
					onReviewTrust={() => {}}
				/>
			)
		);
		expect(screen.getByRole('button', { name: /Review/i })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Open/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /Update/i })).toBeNull();
	});
});

describe('PkgRow — click handling', () => {
	it('clicking the row fires onOpen', async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		render(withQuery(<PkgRow row={makeRow()} onOpen={onOpen} />));
		// The row has data-pkg-id; grab it via the name text.
		const nameEl = screen.getByText('Test Pkg');
		await user.click(nameEl);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'com.test.x' }));
	});

	it('clicking the Open action stops propagation — does not fire onOpen twice', async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		render(withQuery(<PkgRow row={makeRow()} onOpen={onOpen} />));
		await user.click(screen.getByRole('button', { name: /Open/i }));
		// Open's handler is onOpen too, but it should fire exactly once
		// (stopPropagation on the button wrapper prevents the row's onClick
		// from also firing). Verify it didn't double-fire.
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('clicking Install on a registry row fires onInstall, not onOpen', async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		const onInstall = vi.fn();
		render(
			withQuery(
				<PkgRow
					row={makeRow({ origin: 'registry', state: 'not-installed' })}
					onOpen={onOpen}
					onInstall={onInstall}
				/>
			)
		);
		await user.click(screen.getByRole('button', { name: /Install/i }));
		expect(onInstall).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('clicking Update on an outdated row fires onUpdate, not onOpen', async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		const onUpdate = vi.fn();
		render(
			withQuery(
				<PkgRow
					row={makeRow({ latest: '0.2.0' })}
					onOpen={onOpen}
					onUpdate={onUpdate}
				/>
			)
		);
		await user.click(screen.getByRole('button', { name: /Update/i }));
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('clicking Review on a trust-pending row fires onReviewTrust, not onOpen', async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		const onReviewTrust = vi.fn();
		render(
			withQuery(
				<PkgRow
					row={makeRow({
						trust: {
							pkg_id: 'com.test.x',
							version: '0.1.0',
							state: 'needs_approval',
							perms: { shell_execute: [], fs_write_outside_sandbox: [], net: [], vault_keys: [] },
							last_granted_at_ms: null,
							change_reason: null,
							auto_trusted: false,
						},
					})}
					onOpen={onOpen}
					onReviewTrust={onReviewTrust}
				/>
			)
		);
		await user.click(screen.getByRole('button', { name: /Review/i }));
		expect(onReviewTrust).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});
});
