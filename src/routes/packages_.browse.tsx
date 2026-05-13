// Registry browser. Lists every pkg in the signed registry index, classifies
// each row against the kernel's installed state (current / outdated / not
// installed), and drives the install flow through the per-step Rust command.
//
// Trust chain executed here:
//   1. useRegistryIndex() fetches index.json + sig, verifies via @noble/ed25519
//      + @noble/hashes/blake2b (see @ikenga/registry-client/minisign).
//   2. resolveInstallPlan() walks @ikenga/pkg-* deps through the same signed
//      index, building an ordered InstallStep[] (tarball + sha512 + manifest).
//   3. Per step, pkgInstallFromRegistry() invokes the Rust command, which
//      re-verifies the tarball SHA-512 before untar.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	AlertTriangle,
	CheckCircle2,
	Download,
	Loader2,
	RefreshCw,
	Settings as SettingsIcon,
	Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	pkgInstallFromRegistry,
	pkgKernelStatus,
	pkgUninstall,
	type PkgInstalledSummary,
} from '@/lib/tauri-cmd';
import {
	registryKeys,
	useInstallPlanResolver,
	useRefreshRegistry,
	useRegistryIndex,
	useRegistryPkgDetail,
	type InstallStep,
	type RegistryEntry,
} from '@/lib/registry/use-registry';
import { semverCompare } from '@ikenga/registry-client';

// ─── helpers ─────────────────────────────────────────────────────────────────

type RowState = 'current' | 'outdated' | 'not-installed';

interface RowInfo {
	entry: RegistryEntry;
	state: RowState;
	installed?: PkgInstalledSummary;
}

function findInstalledFor(
	entry: RegistryEntry,
	installed: PkgInstalledSummary[],
): PkgInstalledSummary | undefined {
	// Same matcher as use-updates-available — see note there about id↔npm-name
	// mapping. Suffix-match works for today's pkg set.
	const npmShort = entry.name.replace(/^@ikenga\//, '').replace(/^pkg-/, '');
	return installed.find((i) => i.id.replace(/^com\.ikenga\./, '') === npmShort);
}

function classify(entry: RegistryEntry, installed?: PkgInstalledSummary): RowState {
	if (!installed) return 'not-installed';
	return semverCompare(installed.version, entry.latest) < 0 ? 'outdated' : 'current';
}

// ─── page ────────────────────────────────────────────────────────────────────

function BrowsePage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const refreshRegistry = useRefreshRegistry();
	const [filter, setFilter] = useState('');
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);
	const [installProgress, setInstallProgress] = useState<{
		done: number;
		total: number;
		current: string;
	} | null>(null);

	const indexQuery = useRegistryIndex();
	const kernelQuery = useQuery({
		queryKey: ['pkg', 'kernel-status'],
		queryFn: pkgKernelStatus,
		refetchOnWindowFocus: false,
	});

	const planResolver = useInstallPlanResolver(indexQuery.data?.indexUrl);

	const rows: RowInfo[] = useMemo(() => {
		const index = indexQuery.data?.index;
		const installed = kernelQuery.data?.installed ?? [];
		if (!index) return [];
		return index.pkgs.map((entry) => {
			const inst = findInstalledFor(entry, installed);
			return { entry, installed: inst, state: classify(entry, inst) };
		});
	}, [indexQuery.data, kernelQuery.data]);

	const filteredRows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) => {
			return (
				r.entry.name.toLowerCase().includes(q) ||
				(r.entry.description ?? '').toLowerCase().includes(q)
			);
		});
	}, [rows, filter]);

	const selected = useMemo(() => {
		if (selectedName) return rows.find((r) => r.entry.name === selectedName) ?? null;
		return filteredRows[0] ?? null;
	}, [rows, filteredRows, selectedName]);

	const detailQuery = useRegistryPkgDetail(indexQuery.data?.indexUrl, selected?.entry);

	const uninstallMut = useMutation({
		mutationFn: async (pkgId: string) => pkgUninstall(pkgId),
		onSuccess: async () => {
			setInstallError(null);
			await queryClient.invalidateQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setInstallError((e as Error).message ?? String(e)),
	});

	const installMut = useMutation({
		mutationFn: async (row: RowInfo) => {
			if (!row) throw new Error('no pkg selected');
			if (!detailQuery.data) throw new Error('detail not loaded');
			const plan: InstallStep[] = await planResolver.mutateAsync({
				root: detailQuery.data,
			});
			setInstallProgress({ done: 0, total: plan.length, current: plan[0]?.name ?? '' });
			let done = 0;
			for (const step of plan) {
				setInstallProgress({ done, total: plan.length, current: step.name });
				await pkgInstallFromRegistry({
					tarball: step.tarball,
					integrity: step.integrity,
					pkgId: step.pkgId,
					sourceUrl: step.tarball,
				});
				done += 1;
			}
			setInstallProgress({ done, total: plan.length, current: row.entry.name });
			return done;
		},
		onSuccess: async () => {
			setInstallError(null);
			await queryClient.invalidateQueries({ queryKey: ['pkg'] });
			refreshRegistry();
		},
		onError: (e) => setInstallError((e as Error).message ?? String(e)),
		onSettled: () => {
			// Keep the "X of N installed" banner visible briefly so the user
			// sees it land; cleared by the next interaction.
			setTimeout(() => setInstallProgress(null), 2500);
		},
	});

	const handleRefresh = () => {
		refreshRegistry();
		void queryClient.invalidateQueries({ queryKey: ['pkg'] });
	};

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center justify-between border-b border-border px-6 py-2.5">
				<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					Packages · <span className="text-foreground">Browse registry</span>
				</span>
				<div className="flex items-center gap-2">
					<RegistryStatusPill
						loading={indexQuery.isLoading}
						error={indexQuery.error as Error | null}
						count={indexQuery.data?.index.pkgs.length ?? 0}
					/>
					<Button
						size="sm"
						variant="ghost"
						className="h-7"
						onClick={handleRefresh}
						disabled={indexQuery.isFetching}
					>
						<RefreshCw
							className={
								indexQuery.isFetching ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'
							}
						/>
						Refresh
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-7"
						onClick={() => navigate({ to: '/packages' })}
					>
						<SettingsIcon className="mr-1.5 h-3.5 w-3.5" />
						Manage installed
					</Button>
				</div>
			</div>

			{/* Body: list + detail */}
			<div className="flex min-h-0 flex-1">
				{/* Left: list */}
				<div className="flex w-80 shrink-0 flex-col border-r border-border">
					<div className="border-b border-border-soft px-3 py-2">
						<Input
							placeholder="Filter pkgs…"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className="h-8"
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						{indexQuery.isLoading && (
							<div className="px-3 py-4 text-xs text-muted-foreground">
								Verifying signed index…
							</div>
						)}
						{indexQuery.error && (
							<div className="m-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
								{(indexQuery.error as Error).message}
							</div>
						)}
						{!indexQuery.isLoading && filteredRows.length === 0 && (
							<div className="px-3 py-4 text-xs text-muted-foreground">No pkgs match.</div>
						)}
						<ul>
							{filteredRows.map((row) => (
								<BrowseRowItem
									key={row.entry.name}
									row={row}
									selected={selected?.entry.name === row.entry.name}
									onSelect={() => setSelectedName(row.entry.name)}
								/>
							))}
						</ul>
					</div>
				</div>

				{/* Right: detail */}
				<div className="min-w-0 flex-1 overflow-auto">
					{!selected && (
						<div className="grid h-full place-items-center px-6 text-sm text-muted-foreground">
							Select a pkg to see its manifest, capabilities, and install
							options.
						</div>
					)}
					{selected && (
						<DetailPanel
							row={selected}
							detail={detailQuery.data ?? null}
							loading={detailQuery.isLoading}
							error={detailQuery.error as Error | null}
							installing={installMut.isPending}
							installProgress={installProgress}
							installError={installError}
							uninstalling={uninstallMut.isPending}
							onInstall={() => installMut.mutate(selected)}
							onUninstall={() => {
								if (!selected.installed) return;
								uninstallMut.mutate(selected.installed.id);
							}}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── list row ────────────────────────────────────────────────────────────────

function BrowseRowItem({
	row,
	selected,
	onSelect,
}: {
	row: RowInfo;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onSelect}
				className={
					'flex w-full flex-col items-start gap-0.5 border-b border-border-soft px-3 py-2 text-left transition-colors hover:bg-muted ' +
					(selected ? 'bg-muted' : '')
				}
				aria-pressed={selected}
			>
				<div className="flex w-full items-center justify-between gap-2">
					<span className="truncate text-sm font-medium">
						{row.entry.name.replace(/^@ikenga\//, '')}
					</span>
					<StateBadge state={row.state} installedVersion={row.installed?.version} latest={row.entry.latest} />
				</div>
				{row.entry.description && (
					<span className="line-clamp-2 text-[11px] text-muted-foreground">
						{row.entry.description}
					</span>
				)}
				<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
					{row.entry.kind ?? 'pkg'} · v{row.entry.latest}
				</span>
			</button>
		</li>
	);
}

function StateBadge({
	state,
	installedVersion,
	latest,
}: {
	state: RowState;
	installedVersion?: string;
	latest: string;
}) {
	if (state === 'current') {
		return (
			<span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
				<CheckCircle2 className="h-2.5 w-2.5" />
				installed
			</span>
		);
	}
	if (state === 'outdated') {
		return (
			<span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
				<AlertTriangle className="h-2.5 w-2.5" />
				{installedVersion} → {latest}
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
			available
		</span>
	);
}

// ─── detail panel ────────────────────────────────────────────────────────────

interface DetailPanelProps {
	row: RowInfo;
	detail: import('@ikenga/registry-client').PkgDetail | null;
	loading: boolean;
	error: Error | null;
	installing: boolean;
	installProgress: { done: number; total: number; current: string } | null;
	installError: string | null;
	uninstalling: boolean;
	onInstall: () => void;
	onUninstall: () => void;
}

function DetailPanel({
	row,
	detail,
	loading,
	error,
	installing,
	installProgress,
	installError,
	uninstalling,
	onInstall,
	onUninstall,
}: DetailPanelProps) {
	const latestVersion = detail?.versions[0];
	const manifest = latestVersion?.manifest;
	const canInstall = row.state !== 'current';
	const installLabel =
		row.state === 'outdated' ? `Update to v${row.entry.latest}` : `Install v${row.entry.latest}`;

	return (
		<div className="mx-auto max-w-3xl px-6 py-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-xl font-semibold tracking-tight">{row.entry.name}</h2>
					{row.entry.description && (
						<p className="mt-1 text-sm text-muted-foreground">{row.entry.description}</p>
					)}
				</div>
				<div className="flex items-center gap-2">
					{canInstall && (
						<Button
							size="sm"
							onClick={onInstall}
							disabled={installing || !detail}
							className="gap-1.5"
						>
							{installing ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Download className="h-3.5 w-3.5" />
							)}
							{installLabel}
						</Button>
					)}
					{row.installed && row.installed.source?.kind !== 'builtin' && (
						<Button
							size="sm"
							variant="ghost"
							onClick={onUninstall}
							disabled={uninstalling}
							className="gap-1.5 text-destructive hover:text-destructive"
						>
							<Trash2 className="h-3.5 w-3.5" />
							Uninstall
						</Button>
					)}
				</div>
			</div>

			{installProgress && (
				<div className="mt-4 rounded border border-border bg-muted/40 px-3 py-2 text-xs">
					Installed {installProgress.done} of {installProgress.total}
					{installProgress.done < installProgress.total &&
						` — ${installProgress.current}…`}
				</div>
			)}
			{installError && (
				<div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
					{installError}
				</div>
			)}

			<dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs">
				<dt className="text-muted-foreground">Latest</dt>
				<dd className="font-mono">v{row.entry.latest}</dd>
				<dt className="text-muted-foreground">Kind</dt>
				<dd className="font-mono">{row.entry.kind ?? 'pkg'}</dd>
				{row.installed && (
					<>
						<dt className="text-muted-foreground">Installed</dt>
						<dd className="font-mono">
							v{row.installed.version}
							{row.installed.source?.kind && (
								<span className="ml-2 text-muted-foreground/70">
									({row.installed.source.kind})
								</span>
							)}
						</dd>
						<dt className="text-muted-foreground">Path</dt>
						<dd className="truncate font-mono text-muted-foreground">
							{row.installed.install_path}
						</dd>
					</>
				)}
			</dl>

			{loading && (
				<p className="mt-6 text-xs text-muted-foreground">Loading manifest…</p>
			)}
			{error && (
				<p className="mt-6 text-xs text-red-700">{error.message}</p>
			)}

			{manifest && (
				<>
					<section className="mt-6">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Manifest
						</h3>
						<dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
							<dt className="text-muted-foreground">id</dt>
							<dd className="font-mono">{manifest.id}</dd>
							<dt className="text-muted-foreground">version</dt>
							<dd className="font-mono">{manifest.version}</dd>
							<dt className="text-muted-foreground">ikenga_api</dt>
							<dd className="font-mono">{manifest.ikenga_api}</dd>
							{manifest.engine && (
								<>
									<dt className="text-muted-foreground">engine</dt>
									<dd className="font-mono">
										{(manifest.engine as { id?: string }).id ?? '—'}
									</dd>
								</>
							)}
						</dl>
					</section>

					<ManifestBlock label="Permissions" data={manifest.permissions} />
					<ManifestBlock label="UI routes" data={manifest.ui} />
					<ManifestBlock label="MCP servers" data={manifest.mcp} />
					<ManifestBlock label="Sidecars" data={manifest.sidecars} />
				</>
			)}

			{latestVersion && (
				<section className="mt-8">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Release info
					</h3>
					<dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
						<dt className="text-muted-foreground">published</dt>
						<dd>{latestVersion.publishedAt}</dd>
						<dt className="text-muted-foreground">tarball</dt>
						<dd className="truncate font-mono text-[11px]">{latestVersion.tarball}</dd>
						<dt className="text-muted-foreground">integrity</dt>
						<dd className="truncate font-mono text-[11px] text-muted-foreground">
							{latestVersion.integrity}
						</dd>
						{typeof latestVersion.size === 'number' && (
							<>
								<dt className="text-muted-foreground">size</dt>
								<dd className="font-mono">{formatBytes(latestVersion.size)}</dd>
							</>
						)}
					</dl>
				</section>
			)}
		</div>
	);
}

function ManifestBlock({ label, data }: { label: string; data: unknown }) {
	if (!data) return null;
	const empty =
		(Array.isArray(data) && data.length === 0) ||
		(typeof data === 'object' && data !== null && Object.keys(data).length === 0);
	if (empty) return null;
	return (
		<section className="mt-6">
			<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</h3>
			<pre className="mt-2 overflow-auto rounded border border-border-soft bg-muted/40 px-3 py-2 font-mono text-[11px] leading-snug">
				{JSON.stringify(data, null, 2)}
			</pre>
		</section>
	);
}

function RegistryStatusPill({
	loading,
	error,
	count,
}: {
	loading: boolean;
	error: Error | null;
	count: number;
}) {
	if (loading) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
				<Loader2 className="h-2.5 w-2.5 animate-spin" />
				verifying…
			</span>
		);
	}
	if (error) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
				<AlertTriangle className="h-2.5 w-2.5" />
				signature failed
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
			<CheckCircle2 className="h-2.5 w-2.5" />
			{count} signed
		</span>
	);
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Silence unused-import warnings while keeping registryKeys re-exported by
// the hook module. (Used implicitly by the planResolver / detail queries.)
void registryKeys;

export const Route = createFileRoute('/packages_/browse')({
	component: BrowsePage,
});
