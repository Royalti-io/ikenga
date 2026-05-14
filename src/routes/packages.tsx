import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Box, MoreVertical, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
	pkgKernelStatus,
	pkgPreviewManifest,
	pkgSetEnabled,
	pkgSetScope,
	pkgUninstall,
	type PkgInstalledSummary,
	type PkgManifestPreview,
	type PkgScopeWire,
} from '@/lib/tauri-cmd';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
						/>
					</div>
				</div>
			</div>
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
}: {
	row: PkgRow;
	busy: boolean;
	projects: Array<{ id: string; name: string }>;
	activeProjectId: string;
	activeProjectName: string;
	onToggle: () => void;
	onUninstall: () => void;
	onSetScope: (scope: PkgScopeWire | null) => void;
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

export const Route = createFileRoute('/packages')({
	component: PackagesPage,
});
