// The unified pkg surface — assembles titlebar + trust banner + action
// tiles + filter bar + catalog body + loupe sheet + install sheet.
//
// Designed so it can be dropped into /packages (Phase 3) or rendered in
// isolation from a smoke route (Phase 1).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import { usePkgsDerived } from '@/lib/pkgs/use-derived';
import { useUpdater } from '@/lib/updater/use-updater';
import { useShellVersion } from '@/lib/updater/use-shell-version';
import { PkgGroup } from './pkg-row';
import { PkgInstallSheet } from './pkg-install-sheet';
import { PkgLoupe, type LoupeTab } from './pkg-loupe';
import { PkgsActionTiles } from './pkgs-action-tiles';
import { PkgsFilterBar, type FilterKey } from './pkgs-filter-bar';
import { PkgsTitlebar } from './pkgs-titlebar';
import { PkgsTrustBanner } from './pkgs-trust-banner';

export interface PkgsSurfaceProps {
	/** Initial filter pill seeded from the URL (?filter=) or sidebar click. */
	initialFilter?: FilterKey;
}

export function PkgsSurface({ initialFilter = 'all' }: PkgsSurfaceProps = {}) {
	const d = usePkgsDerived();
	const navigate = useNavigate();
	// Lightweight shell-update read — autoPoll: false here because the workspace
	// UpdaterBanner owns the 6h polling timer. We just need the latest value
	// for the cross-link line in the Updates tile.
	const updater = useUpdater({ autoPoll: false });
	const shellVersion = useShellVersion();
	const shellUpdate = updater.available
		? {
				currentVersion: updater.available.currentVersion ?? shellVersion ?? '—',
				version: updater.available.version,
			}
		: null;

	const [filter, setFilter] = useState<FilterKey>(initialFilter);
	// Re-sync if the parent route flips the search param after mount (sidebar
	// click while already on /packages).
	useEffect(() => {
		setFilter(initialFilter);
	}, [initialFilter]);
	const [query, setQuery] = useState('');
	const [loupePkg, setLoupePkg] = useState<PkgRowV2 | null>(null);
	const [loupeTab, setLoupeTab] = useState<LoupeTab>('overview');
	const [installOpen, setInstallOpen] = useState(false);
	const [installPkg, setInstallPkg] = useState<PkgRowV2 | null>(null);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		let rows: PkgRowV2[] = d.rows;
		if (filter === 'installed') rows = d.installed;
		else if (filter === 'store') rows = d.registry;
		else if (filter === 'updates') rows = d.updates;
		else if (filter === 'review')
			rows = [...d.trust, ...d.violations.filter((r) => !d.trust.find((t) => t.id === r.id))];
		else if (filter === 'disabled') rows = d.installed.filter((r) => !r.enabled);
		if (q) {
			rows = rows.filter(
				(r) =>
					r.name.toLowerCase().includes(q) ||
					r.id.toLowerCase().includes(q) ||
					r.routes.some((rt) => rt.toLowerCase().includes(q))
			);
		}
		return rows;
	}, [d, filter, query]);

	const groups = useMemo(() => {
		// Reuse the origin grouping from the artifact for the unified list,
		// but only show groups that contain visible rows after filtering.
		const byOrigin: Record<string, PkgRowV2[]> = {
			'Built-in · com.ikenga': [],
			Engine: [],
			'User · com.royalti': [],
			'Available in registry': [],
		};
		for (const row of visible) {
			if (row.origin === 'builtin') byOrigin['Built-in · com.ikenga'].push(row);
			else if (row.origin === 'engine') byOrigin.Engine.push(row);
			else if (row.origin === 'user') byOrigin['User · com.royalti'].push(row);
			else byOrigin['Available in registry'].push(row);
		}
		return byOrigin;
	}, [visible]);

	const openLoupe = (row: PkgRowV2, tab: LoupeTab = 'overview') => {
		setLoupePkg(row);
		setLoupeTab(tab);
	};

	return (
		<div className="flex h-full flex-col bg-background">
			<PkgsTitlebar
				d={d}
				onInstallPkg={() => {
					setInstallPkg(null);
					setInstallOpen(true);
				}}
			/>
			<PkgsTrustBanner
				d={d}
				onReview={() => {
					setFilter('review');
				}}
			/>
			<PkgsActionTiles
				d={d}
				shellUpdate={shellUpdate}
				onShellUpdate={() => navigate({ to: '/settings/about' })}
				onReviewUpdates={() => setFilter('updates')}
				onReviewTrust={() => setFilter('review')}
				onReviewViolations={() => setFilter('review')}
				onBrowseRegistry={() => setFilter('store')}
			/>
			<PkgsFilterBar
				d={d}
				active={filter}
				onChange={setFilter}
				query={query}
				onQueryChange={setQuery}
			/>
			<div className="flex-1 overflow-y-auto px-6 py-5">
				{d.error && (
					<p className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
						{d.error}
					</p>
				)}
				{d.isLoading && !d.installed.length && (
					<p className="text-sm text-muted-foreground">Loading kernel status…</p>
				)}
				{!d.isLoading && !visible.length && (
					<p className="text-sm text-muted-foreground">
						{query
							? `No packages match "${query}".`
							: filter === 'updates'
								? 'Nothing to update.'
								: filter === 'review'
									? 'Nothing needs review.'
									: 'No packages installed.'}
					</p>
				)}
				<div className="space-y-6">
					{Object.entries(groups).map(([label, rows]) => (
						<PkgGroup
							key={label}
							label={label}
							rows={rows}
							onOpen={(row) => openLoupe(row, 'overview')}
							onInstall={(row) => {
								setInstallPkg(row);
								setInstallOpen(true);
							}}
							onUpdate={(row) => openLoupe(row, 'overview')}
							onReviewTrust={(row) => openLoupe(row, 'trust')}
						/>
					))}
				</div>
			</div>
			<PkgLoupe
				row={loupePkg}
				tab={loupeTab}
				open={!!loupePkg}
				onOpenChange={(open) => !open && setLoupePkg(null)}
				onInstall={(row) => {
					setInstallPkg(row);
					setInstallOpen(true);
				}}
			/>
			<PkgInstallSheet open={installOpen} onOpenChange={setInstallOpen} pkg={installPkg} />
		</div>
	);
}
