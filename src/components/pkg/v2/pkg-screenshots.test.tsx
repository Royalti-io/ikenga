// Render tests for the screenshot carousel. The non-trivial behaviour is
// the thumb-strip click swapping the main image + caption; everything else
// is presentational. We render with registry-kind screenshots (urls live
// directly on the ref, no Tauri command roundtrip) so the test is fully
// hermetic.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { PkgScreenshotCarousel } from './pkg-screenshots';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';

afterEach(cleanup);

// useScreenshotSrc calls useQuery (even when disabled) so the carousel
// needs a QueryClient in scope to render. Per-test client keeps caches
// from bleeding between tests.
function withQuery(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeRow(screenshots: PkgRowV2['screenshots']): PkgRowV2 {
	return {
		id: 'com.test.x',
		name: 'Test',
		version: '0.1.0',
		origin: 'registry',
		kind: 'ui',
		state: 'not-installed',
		enabled: false,
		desc: '',
		installPath: '(not installed)',
		installedAt: null,
		latest: '0.1.0',
		scopes: [],
		routes: [],
		sidecars: [],
		trust: null,
		violations: [],
		screenshots,
		installed: null,
		manifest: null,
		registryEntry: null,
	};
}

function urlShot(src: string, caption: string | null = null) {
	return { kind: 'url' as const, src, caption };
}

describe('PkgScreenshotCarousel', () => {
	it('renders the "no screenshots" stub when shots is empty', () => {
		render(withQuery(<PkgScreenshotCarousel row={makeRow([])} />));
		expect(screen.getByText(/No screenshots — this pkg has no UI/i)).toBeTruthy();
	});

	it('renders the screenshots count in the section label', () => {
		render(
			withQuery(
				<PkgScreenshotCarousel
					row={makeRow([urlShot('https://cdn.example/a.png', 'First')])}
				/>
			)
		);
		expect(screen.getByText(/screenshots · 1/i)).toBeTruthy();
	});

	it('paints "what you’ll get" suffix in install-preview variant', () => {
		render(
			withQuery(
				<PkgScreenshotCarousel
					row={makeRow([urlShot('https://cdn.example/a.png')])}
					variant="install-preview"
				/>
			)
		);
		expect(screen.getByText(/screenshots · 1 · what you’ll get/i)).toBeTruthy();
	});

	it('renders the first caption on mount', () => {
		render(
			withQuery(
				<PkgScreenshotCarousel
					row={makeRow([
						urlShot('https://cdn.example/a.png', 'Inbox view'),
						urlShot('https://cdn.example/b.png', 'Drafts view'),
					])}
				/>
			)
		);
		expect(screen.getByText('Inbox view')).toBeTruthy();
		expect(screen.queryByText('Drafts view')).toBeNull();
	});

	it('omits the thumb strip when only one screenshot', () => {
		const { container } = render(
			withQuery(
				<PkgScreenshotCarousel row={makeRow([urlShot('https://cdn.example/only.png')])} />
			)
		);
		// Only the main image bg-cover div exists, no strip buttons.
		expect(container.querySelectorAll('button').length).toBe(0);
	});

	it('renders a thumb button per screenshot when >1', () => {
		render(
			withQuery(
				<PkgScreenshotCarousel
					row={makeRow([
						urlShot('https://cdn.example/a.png', 'A'),
						urlShot('https://cdn.example/b.png', 'B'),
						urlShot('https://cdn.example/c.png', 'C'),
					])}
				/>
			)
		);
		// 3 thumb buttons in the strip.
		expect(screen.getAllByRole('button').length).toBe(3);
	});

	it('swaps caption when a thumb is clicked', async () => {
		const user = userEvent.setup();
		render(
			withQuery(
				<PkgScreenshotCarousel
					row={makeRow([
						urlShot('https://cdn.example/a.png', 'A caption'),
						urlShot('https://cdn.example/b.png', 'B caption'),
					])}
				/>
			)
		);
		expect(screen.getByText('A caption')).toBeTruthy();
		const thumbs = screen.getAllByRole('button');
		await user.click(thumbs[1]);
		expect(screen.getByText('B caption')).toBeTruthy();
		expect(screen.queryByText('A caption')).toBeNull();
	});
});
