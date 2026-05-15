import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Box, MoreVertical, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
	pkgKernelStatus,
	pkgPermissionViolationsClear,
	pkgPermissionViolationsList,
	pkgPreviewManifest,
	pkgSetEnabled,
	pkgSetScope,
	pkgTrustGrant,
	pkgTrustList,
	pkgTrustRevoke,
	pkgUninstall,
	type PkgInstalledSummary,
	type PkgManifestPreview,
	type PkgPermissionViolation,
	type PkgScopeWire,
	type PkgTrustEntry,
} from '@/lib/tauri-cmd';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useShellStore } from '@/lib/shell/shell-store';

interface PkgRow {
	installed: PkgInstalledSummary;
	manifest: PkgManifestPreview | null;
	manifestError: string | null;
}

type GroupKey = 'builtin' | 'engine' | 'user';

// HSL palette pulled from `<workspace>/design/shell/concepts/04-pkgs/03-settings.html` (lines 314-323)
const TINTS: Array<{ name: string; hsl: string }> = [
	{ name: 'amber', hsl: 'hsl(36,84%,56%)' },
	{ name: 'teal', hsl: 'hsl(170,45%,50%)' },
	{ name: 'gold', hsl: 'hsl(42,84%,60%)' },
	{ name: 'coral', hsl: 'hsl(8,72%,62%)' },
	{ name: 'neutral', hsl: 'hsl(28,18%,60%)' },
	{ name: 'warm', hsl: 'hsl(20,55%,52%)' },
	{ name: 'iyke', hsl: 'hsl(280,40%,60%)' },
	{ name: 'rose', hsl: 'hsl(340,60%,62%)' },
	{ name: 'plum', hsl: 'hsl(310,40%,52%)' },
	{ name: 'sage', hsl: 'hsl(140,28%,52%)' },
];

function tintFor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	const idx = Math.abs(hash) % TINTS.length;
	return TINTS[idx].hsl;
}

function classifyGroup(row: PkgRow): GroupKey {
	const kind = row.manifest?.kind ?? null;
	// Engine kind wins regardless of source — the engine pkg ships as a
	// builtin today, but the UI groups it under ENGINE either way.
	if (kind === 'engine') return 'engine';
	if (row.installed.source?.kind === 'builtin') return 'builtin';
	return 'user';
}

type RowState = 'running' | 'idle' | 'disabled';

function deriveState(row: PkgRow): RowState {
	if (!row.installed.enabled) return 'disabled';
	const hasSidecars = (row.manifest?.sidecars?.length ?? 0) > 0;
	return hasSidecars ? 'running' : 'idle';
}

function descriptionFor(row: PkgRow): string {
	const summary = (row.manifest?.permissions as { summary?: unknown } | undefined)?.summary;
	if (typeof summary === 'string' && summary.trim()) return summary;
	if (row.manifest?.kind) return row.manifest.kind;
	return '—';
}

export function PackagesPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState('');

	const setEnabledMut = useMutation({
		mutationFn: ({ pkgId, enabled }: { pkgId: string; enabled: boolean }) =>
			pkgSetEnabled(pkgId, enabled),
		onSuccess: async () => {
			setError(null);
			await qc.refetchQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});

	const uninstallMut = useMutation({
		mutationFn: (pkgId: string) => pkgUninstall(pkgId),
		onSuccess: async () => {
			setError(null);
			await qc.refetchQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});

	const setScopeMut = useMutation({
		mutationFn: ({ pkgId, scope }: { pkgId: string; scope: PkgScopeWire | null }) =>
			pkgSetScope(pkgId, scope),
		onSuccess: async () => {
			setError(null);
			await qc.refetchQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});

	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const activeProject = projects.find((p) => p.id === activeProjectId);

	const status = useQuery({
		queryKey: ['pkg', 'kernel-status'],
		queryFn: pkgKernelStatus,
		refetchOnWindowFocus: false,
	});

	// Phase 9 — trust gating. List comes back small (one entry per installed
	// pkg) so we just refetch alongside `pkg` queries.
	const trustList = useQuery({
		queryKey: ['pkg', 'trust-list'],
		queryFn: pkgTrustList,
		refetchOnWindowFocus: false,
	});
	const trustByPkg = useMemo(() => {
		const out = new Map<string, PkgTrustEntry>();
		for (const t of trustList.data ?? []) out.set(t.pkg_id, t);
		return out;
	}, [trustList.data]);

	const grantMut = useMutation({
		mutationFn: ({ pkgId, version }: { pkgId: string; version: string }) =>
			pkgTrustGrant(pkgId, version),
		onSuccess: async () => {
			setError(null);
			await qc.refetchQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});
	const revokeMut = useMutation({
		mutationFn: (pkgId: string) => pkgTrustRevoke(pkgId),
		onSuccess: async () => {
			setError(null);
			await qc.refetchQueries({ queryKey: ['pkg'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});

	// Open-Review dialog state. Holds the trust entry under review; null = closed.
	const [reviewing, setReviewing] = useState<PkgTrustEntry | null>(null);

	// Runtime-ACL violations audit. Cross-pkg list at the page level → per-pkg
	// count map for the row badge. Rows are short-lived (each entry is one
	// blocked spawn attempt), so refetching alongside `pkg` queries is fine.
	const violations = useQuery({
		queryKey: ['pkg', 'violations-list'],
		queryFn: () => pkgPermissionViolationsList(undefined, 1000),
		refetchOnWindowFocus: false,
	});
	const violationCountByPkg = useMemo(() => {
		const out = new Map<string, number>();
		for (const v of violations.data ?? []) {
			out.set(v.pkg_id, (out.get(v.pkg_id) ?? 0) + 1);
		}
		return out;
	}, [violations.data]);
	const [reviewingViolations, setReviewingViolations] = useState<string | null>(null);
	const clearViolationsMut = useMutation({
		mutationFn: (pkgId: string) => pkgPermissionViolationsClear(pkgId),
		onSuccess: async () => {
			await qc.refetchQueries({ queryKey: ['pkg', 'violations-list'] });
		},
		onError: (e) => setError((e as Error).message ?? String(e)),
	});

	const installPaths = (status.data?.installed ?? []).map((p) => p.install_path);
	const manifests = useQuery({
		enabled: installPaths.length > 0,
		queryKey: ['pkg', 'manifests', installPaths.join('|')],
		staleTime: Infinity,
		queryFn: async (): Promise<Record<string, PkgManifestPreview | { _error: string }>> => {
			const out: Record<string, PkgManifestPreview | { _error: string }> = {};
			await Promise.all(
				installPaths.map(async (path) => {
					try {
						out[path] = await pkgPreviewManifest(path);
					} catch (e) {
						out[path] = { _error: (e as Error).message ?? String(e) };
					}
				})
			);
			return out;
		},
	});

	const rows: PkgRow[] = (status.data?.installed ?? []).map((s) => {
		const m = manifests.data?.[s.install_path];
		const isError = m && '_error' in m;
		return {
			installed: s,
			manifest: m && !isError ? (m as PkgManifestPreview) : null,
			manifestError: isError ? (m as { _error: string })._error : null,
		};
	});

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((row) => {
			const name = (row.manifest?.name ?? row.installed.id).toLowerCase();
			const id = row.installed.id.toLowerCase();
			return name.includes(q) || id.includes(q);
		});
	}, [rows, filter]);

	const grouped = useMemo(() => {
		const out: Record<GroupKey, PkgRow[]> = { builtin: [], engine: [], user: [] };
		for (const r of filtered) out[classifyGroup(r)].push(r);
		return out;
	}, [filtered]);

	const totalInstalled = rows.length;
	const hasFilter = filter.trim().length > 0;

	const handleToggle = (row: PkgRow) =>
		setEnabledMut.mutate({ pkgId: row.installed.id, enabled: !row.installed.enabled });

	const handleUninstall = async (row: PkgRow) => {
		const msg = `Uninstall ${row.manifest?.name ?? row.installed.id}? This drops the pkg row, settings, and granted permissions. The on-disk install path is left alone.`;
		let ok = false;
		try {
			ok = await confirmDialog(msg, { title: 'Uninstall pkg', kind: 'warning' });
		} catch {
			ok = window.confirm(msg);
		}
		if (ok) uninstallMut.mutate(row.installed.id);
	};

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar / breadcrumb */}
			<div className="flex items-center justify-between border-b border-border px-6 py-2.5">
				<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					Settings · <span className="text-foreground">Packages</span>
				</span>
				<StatusPill totalInstalled={totalInstalled} />
			</div>

			<div className="flex-1 overflow-auto px-6 py-6">
				<div className="mx-auto max-w-4xl">
					<h2 className="text-xl font-semibold tracking-tight">Packages</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Install, update, and toggle the pkgs that make up your workspace. The shell discovers
						manifests at boot — disabling unmounts the iframe and any sidecars; uninstalling removes
						the directory.
					</p>

					{/* Action row */}
					<div className="mt-5 flex items-center gap-2">
						<div className="relative flex-1">
							<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								placeholder="Filter installed pkgs…"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								className="h-9 pl-8"
							/>
						</div>
						<Button size="sm" className="h-9 gap-1.5" onClick={() => navigate({ to: '/install' })}>
							<Plus className="h-3.5 w-3.5" />
							Install
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="h-9"
							onClick={() => navigate({ to: '/packages/browse' })}
						>
							Browse registry →
						</Button>
					</div>

					{/* Loading + error states */}
					{status.isLoading && (
						<p className="mt-4 text-xs text-muted-foreground">Loading kernel status…</p>
					)}
					{status.error && (
						<p className="mt-4 text-xs text-red-700">
							Failed to read kernel status: {(status.error as Error).message}
						</p>
					)}
					{error && (
						<p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
							{error}
						</p>
					)}

					{/* Empty state */}
					{status.data && totalInstalled === 0 && !manifests.isLoading && (
						<p className="mt-6 text-sm text-muted-foreground">No pkgs installed.</p>
					)}
					{totalInstalled > 0 && filtered.length === 0 && hasFilter && (
						<p className="mt-6 text-sm text-muted-foreground">
							No packages match &ldquo;{filter}&rdquo;.
						</p>
					)}

					{/* Groups */}
					<div className="mt-6 space-y-6">
						<PkgGroup
							title="Built-in"
							tag="shipped with shell · cannot uninstall"
							items={grouped.builtin}
							busyEnabled={setEnabledMut}
							busyUninstall={uninstallMut}
							busyScope={setScopeMut}
							projects={projects.map((p) => ({ id: p.id, name: p.display_name }))}
							activeProjectId={activeProjectId}
							activeProjectName={activeProject?.display_name ?? activeProjectId}
							onToggle={handleToggle}
							onUninstall={handleUninstall}
							onSetScope={(pkgId, scope) => setScopeMut.mutate({ pkgId, scope })}
							trustByPkg={trustByPkg}
							onReviewTrust={setReviewing}
							onRevokeTrust={(pkgId) => revokeMut.mutate(pkgId)}
							violationCountByPkg={violationCountByPkg}
							onReviewViolations={setReviewingViolations}
						/>
						<PkgGroup
							title="Engine"
							tag="default pkg · update independently of shell"
							items={grouped.engine}
							busyEnabled={setEnabledMut}
							busyUninstall={uninstallMut}
							busyScope={setScopeMut}
							projects={projects.map((p) => ({ id: p.id, name: p.display_name }))}
							activeProjectId={activeProjectId}
							activeProjectName={activeProject?.display_name ?? activeProjectId}
							onToggle={handleToggle}
							onUninstall={handleUninstall}
							onSetScope={(pkgId, scope) => setScopeMut.mutate({ pkgId, scope })}
							trustByPkg={trustByPkg}
							onReviewTrust={setReviewing}
							onRevokeTrust={(pkgId) => revokeMut.mutate(pkgId)}
							violationCountByPkg={violationCountByPkg}
							onReviewViolations={setReviewingViolations}
						/>
						<PkgGroup
							title="Installed"
							tag={`${grouped.user.length} pkg${grouped.user.length === 1 ? '' : 's'}`}
							items={grouped.user}
							busyEnabled={setEnabledMut}
							busyUninstall={uninstallMut}
							busyScope={setScopeMut}
							projects={projects.map((p) => ({ id: p.id, name: p.display_name }))}
							activeProjectId={activeProjectId}
							activeProjectName={activeProject?.display_name ?? activeProjectId}
							onToggle={handleToggle}
							onUninstall={handleUninstall}
							onSetScope={(pkgId, scope) => setScopeMut.mutate({ pkgId, scope })}
							trustByPkg={trustByPkg}
							onReviewTrust={setReviewing}
							onRevokeTrust={(pkgId) => revokeMut.mutate(pkgId)}
							violationCountByPkg={violationCountByPkg}
							onReviewViolations={setReviewingViolations}
						/>
					</div>
				</div>
			</div>

			{reviewing && (
				<TrustReviewDialog
					entry={reviewing}
					onClose={() => setReviewing(null)}
					onApprove={async () => {
						const t = reviewing;
						setReviewing(null);
						await grantMut.mutateAsync({ pkgId: t.pkg_id, version: t.version });
					}}
					busy={grantMut.isPending}
				/>
			)}

			{reviewingViolations && (
				<ViolationsReviewDialog
					pkgId={reviewingViolations}
					onClose={() => setReviewingViolations(null)}
					onClear={async () => {
						const id = reviewingViolations;
						setReviewingViolations(null);
						await clearViolationsMut.mutateAsync(id);
					}}
					busy={clearViolationsMut.isPending}
				/>
			)}
		</div>
	);
}

function StatusPill({ totalInstalled }: { totalInstalled: number }) {
	// Update-availability is not exposed by the kernel today; show installed count.
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
			<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
			{totalInstalled} installed
		</span>
	);
}

function PkgGroup({
	title,
	tag,
	items,
	busyEnabled,
	busyUninstall,
	busyScope,
	projects,
	activeProjectId,
	activeProjectName,
	onToggle,
	onUninstall,
	onSetScope,
	trustByPkg,
	onReviewTrust,
	onRevokeTrust,
	violationCountByPkg,
	onReviewViolations,
}: {
	title: string;
	tag: string;
	items: PkgRow[];
	busyEnabled: { isPending: boolean; variables?: { pkgId: string; enabled: boolean } };
	busyUninstall: { isPending: boolean; variables?: string };
	busyScope: { isPending: boolean; variables?: { pkgId: string; scope: PkgScopeWire | null } };
	projects: Array<{ id: string; name: string }>;
	activeProjectId: string;
	activeProjectName: string;
	onToggle: (row: PkgRow) => void;
	onUninstall: (row: PkgRow) => void;
	onSetScope: (pkgId: string, scope: PkgScopeWire | null) => void;
	trustByPkg: Map<string, PkgTrustEntry>;
	onReviewTrust: (entry: PkgTrustEntry) => void;
	onRevokeTrust: (pkgId: string) => void;
	violationCountByPkg: Map<string, number>;
	onReviewViolations: (pkgId: string) => void;
}) {
	if (items.length === 0) return null;
	return (
		<section className="overflow-hidden rounded-lg border border-[var(--border-soft)] bg-card">
			<header className="flex items-center justify-between border-b border-[var(--border-soft)] bg-[var(--bg-sunken)] px-4 py-2">
				<span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					{title}
				</span>
				<span className="text-[11px] text-muted-foreground/70">{tag}</span>
			</header>
			<div className="divide-y divide-border">
				{items.map((row) => {
					const busy =
						(busyEnabled.isPending && busyEnabled.variables?.pkgId === row.installed.id) ||
						(busyUninstall.isPending && busyUninstall.variables === row.installed.id) ||
						(busyScope.isPending && busyScope.variables?.pkgId === row.installed.id);
					return (
						<PkgRowItem
							key={row.installed.id}
							row={row}
							busy={busy}
							projects={projects}
							activeProjectId={activeProjectId}
							activeProjectName={activeProjectName}
							onToggle={() => onToggle(row)}
							onUninstall={() => onUninstall(row)}
							onSetScope={(scope) => onSetScope(row.installed.id, scope)}
							trust={trustByPkg.get(row.installed.id) ?? null}
							onReviewTrust={onReviewTrust}
							onRevokeTrust={onRevokeTrust}
							violationCount={violationCountByPkg.get(row.installed.id) ?? 0}
							onReviewViolations={onReviewViolations}
						/>
					);
				})}
			</div>
		</section>
	);
}

function PkgRowItem({
	row,
	busy,
	projects,
	activeProjectId,
	activeProjectName,
	onToggle,
	onUninstall,
	onSetScope,
	trust,
	onReviewTrust,
	onRevokeTrust,
	violationCount,
	onReviewViolations,
}: {
	row: PkgRow;
	busy: boolean;
	projects: Array<{ id: string; name: string }>;
	activeProjectId: string;
	activeProjectName: string;
	onToggle: () => void;
	onUninstall: () => void;
	onSetScope: (scope: PkgScopeWire | null) => void;
	trust: PkgTrustEntry | null;
	onReviewTrust: (entry: PkgTrustEntry) => void;
	onRevokeTrust: (pkgId: string) => void;
	violationCount: number;
	onReviewViolations: (pkgId: string) => void;
}) {
	const { installed, manifest, manifestError } = row;
	const name = manifest?.name ?? installed.id;
	const description = descriptionFor(row);
	const state = deriveState(row);
	const tintColor = tintFor(installed.id);
	// Source-of-truth: the kernel records provenance on install. The uninstall
	// command will refuse `builtin` source server-side too — this is the UI hint.
	const isBuiltIn = installed.source?.kind === 'builtin';
	const scope: PkgScopeWire | null = installed.project_id
		? (`project:${installed.project_id}` as const)
		: 'workspace';
	const scopeLabel =
		scope === 'workspace'
			? 'workspace'
			: projects.find((p) => p.id === installed.project_id)?.name
				?? installed.project_id
				?? 'project';

	const stateDotColor =
		state === 'running'
			? 'bg-emerald-500'
			: state === 'disabled'
				? 'bg-muted-foreground/40'
				: 'bg-muted-foreground/70';

	return (
		<div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				{/* Tile */}
				<div
					className="relative h-8 w-8 shrink-0 rounded-md border border-border bg-muted"
					aria-hidden
				>
					<div
						className="absolute inset-1.5 rounded-[3px] opacity-85"
						style={{ background: tintColor }}
					/>
					<Box className="pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 text-white/90" />
				</div>

				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium">{name}</span>
						<span className="font-mono text-[10.5px] tracking-wide text-muted-foreground/70">
							v{installed.version}
						</span>
						{!installed.compatible && (
							<span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
								incompatible
							</span>
						)}
					</div>
					<div className="mt-0.5 truncate text-xs text-muted-foreground">
						<code className="font-mono text-[11px] text-muted-foreground/70">{installed.id}</code>
						{' · '}
						{manifestError ? (
							<span className="text-red-700">manifest unreadable: {manifestError}</span>
						) : (
							description
						)}
					</div>
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-3">
				<TrustChip trust={trust} onReview={onReviewTrust} />
				<ViolationsChip
					count={violationCount}
					onReview={() => onReviewViolations(installed.id)}
				/>
				<span
					className="inline-flex min-w-[56px] items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
					title={`scope: ${scope}`}
				>
					<span className="opacity-70">{scopeLabel}</span>
				</span>
				<span className="inline-flex min-w-[56px] items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					<span className={`h-1.5 w-1.5 rounded-full ${stateDotColor}`} />
					{state}
				</span>
				<Switch
					checked={installed.enabled}
					onCheckedChange={onToggle}
					disabled={busy || !installed.compatible}
					aria-label={installed.enabled ? `Disable ${name}` : `Enable ${name}`}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
							aria-label={`Manage ${name}`}
						>
							<MoreVertical className="h-3.5 w-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							disabled={busy || scope === 'workspace'}
							onSelect={(e) => {
								e.preventDefault();
								onSetScope('workspace');
							}}
						>
							Move to workspace
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={busy || scope === `project:${activeProjectId}`}
							onSelect={(e) => {
								e.preventDefault();
								onSetScope(`project:${activeProjectId}` as const);
							}}
						>
							Move to {activeProjectName}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						{trust?.state === 'granted' && (
							<DropdownMenuItem
								disabled={busy}
								onSelect={(e) => {
									e.preventDefault();
									onRevokeTrust(installed.id);
								}}
								title="Revoke trust — MCP tools/call against this pkg will be blocked until re-approved"
							>
								Revoke trust
							</DropdownMenuItem>
						)}
						<DropdownMenuItem
							variant="destructive"
							disabled={busy || isBuiltIn}
							onSelect={(e) => {
								e.preventDefault();
								if (!isBuiltIn) onUninstall();
							}}
							title={isBuiltIn ? 'Built-in pkgs cannot be uninstalled' : undefined}
						>
							Uninstall
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

function TrustChip({
	trust,
	onReview,
}: {
	trust: PkgTrustEntry | null;
	onReview: (entry: PkgTrustEntry) => void;
}) {
	// No trust entry yet (still loading or kernel listing miss) — render
	// nothing rather than a misleading state.
	if (!trust) return null;
	const base =
		'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider';
	if (trust.state === 'auto_trusted') {
		return (
			<span
				className={`${base} border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300`}
				title="Built-in pkg shipped with the shell — auto-trusted"
			>
				built-in
			</span>
		);
	}
	if (trust.state === 'auto_granted') {
		return (
			<span
				className={`${base} border border-border bg-muted text-muted-foreground`}
				title="No sensitive permissions declared — auto-granted on install"
			>
				no perms
			</span>
		);
	}
	if (trust.state === 'granted') {
		return (
			<span
				className={`${base} border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300`}
				title={`Approved v${trust.version}`}
			>
				approved v{trust.version}
			</span>
		);
	}
	// needs_approval
	const reason = trust.change_reason?.kind ?? 'never';
	const tip =
		reason === 'permissions_changed'
			? 'Permissions changed since last approval — re-review'
			: reason === 'revoked'
				? 'Trust was revoked — re-approve to re-enable MCP calls'
				: 'Sensitive permissions declared but never approved';
	return (
		<button
			type="button"
			onClick={() => onReview(trust)}
			className={`${base} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50`}
			title={tip}
		>
			review… ›
		</button>
	);
}

function TrustReviewDialog({
	entry,
	onClose,
	onApprove,
	busy,
}: {
	entry: PkgTrustEntry;
	onClose: () => void;
	onApprove: () => void;
	busy: boolean;
}) {
	const reasonLine =
		entry.change_reason?.kind === 'permissions_changed'
			? `Permissions changed since v${entry.change_reason.prior_version}.`
			: entry.change_reason?.kind === 'revoked'
				? 'Trust was previously revoked.'
				: 'This package has not been approved before.';
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Approve “{entry.pkg_id}” v{entry.version}</DialogTitle>
					<DialogDescription>{reasonLine} This package wants to:</DialogDescription>
				</DialogHeader>
				<PermsList perms={entry.perms} />
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Deny
					</Button>
					<Button onClick={onApprove} disabled={busy}>
						{busy ? 'Approving…' : 'Approve'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PermsList({ perms }: { perms: PkgTrustEntry['perms'] }) {
	const sections: Array<{ label: string; entries: string[] }> = [
		{ label: 'Run shell commands matching', entries: perms.shell_execute },
		{ label: 'Write files matching', entries: perms.fs_write_outside_sandbox },
		{ label: 'Make network requests to', entries: perms.net },
		{ label: 'Read vault keys matching', entries: perms.vault_keys },
	];
	const populated = sections.filter((s) => s.entries.length > 0);
	if (populated.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No sensitive permissions declared. (You should not normally see this dialog.)
			</p>
		);
	}
	return (
		<ul className="space-y-3 text-sm">
			{populated.map((s) => (
				<li key={s.label}>
					<div className="text-xs font-medium text-muted-foreground">{s.label}:</div>
					<ul className="mt-1 list-disc pl-5 font-mono text-[11.5px] text-foreground">
						{s.entries.map((e) => (
							<li key={e} className="break-all">
								{e}
							</li>
						))}
					</ul>
				</li>
			))}
		</ul>
	);
}

// Runtime-ACL violations chip — neutral chrome (yellow, not red) because the
// spawn that triggered the row was already denied. This is observability,
// not an active security incident.
function ViolationsChip({
	count,
	onReview,
}: {
	count: number;
	onReview: () => void;
}) {
	if (count <= 0) return null;
	const base =
		'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors hover:opacity-90';
	return (
		<button
			type="button"
			onClick={onReview}
			className={`${base} border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300`}
			title="Permission violations recorded — click to review (denied spawns; no action required)"
		>
			{count} blocked
		</button>
	);
}

function ViolationsReviewDialog({
	pkgId,
	onClose,
	onClear,
	busy,
}: {
	pkgId: string;
	onClose: () => void;
	onClear: () => void | Promise<void>;
	busy: boolean;
}) {
	const rows = useQuery({
		queryKey: ['pkg', 'violations-list', pkgId],
		queryFn: () => pkgPermissionViolationsList(pkgId, 100),
	});
	return (
		<Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Permission violations — {pkgId}</DialogTitle>
					<DialogDescription>
						Each row is a kernel-level deny: the pkg attempted to spawn a binary that wasn’t in
						its declared <code className="font-mono">shell.execute</code> allowlist. The spawn was
						blocked; this log is for observability only.
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[50vh] overflow-y-auto rounded border border-border">
					{rows.isLoading && (
						<p className="p-3 text-xs text-muted-foreground">Loading…</p>
					)}
					{rows.isError && (
						<p className="p-3 text-xs text-red-700">
							Could not load: {(rows.error as Error).message}
						</p>
					)}
					{rows.data && rows.data.length === 0 && (
						<p className="p-3 text-xs text-muted-foreground">No violations.</p>
					)}
					{rows.data && rows.data.length > 0 && (
						<table className="w-full table-fixed text-[11.5px]">
							<thead className="bg-[var(--bg-sunken)] text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
								<tr>
									<th className="w-1/4 px-3 py-2">When</th>
									<th className="w-1/3 px-3 py-2">Attempted</th>
									<th className="w-5/12 px-3 py-2">Declared</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border font-mono">
								{rows.data.map((v: PkgPermissionViolation) => (
									<tr key={v.id}>
										<td className="px-3 py-1.5 text-muted-foreground">
											{new Date(v.occurred_at).toLocaleString()}
										</td>
										<td className="break-all px-3 py-1.5">{v.attempted}</td>
										<td className="break-all px-3 py-1.5 text-muted-foreground">
											{v.declared || <em className="not-italic opacity-60">empty</em>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
				<DialogFooter className="gap-2 sm:gap-2">
					<Button
						variant="outline"
						onClick={onClose}
						disabled={busy}
					>
						Close
					</Button>
					<Button
						variant="destructive"
						onClick={() => void onClear()}
						disabled={busy || !rows.data || rows.data.length === 0}
					>
						{busy ? 'Clearing…' : 'Clear log'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export const Route = createFileRoute('/packages')({
	component: PackagesPage,
});
