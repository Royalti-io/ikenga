// Install sheet — re-uses the loupe chrome with three tabs (Manifest URL ·
// Local path · Registry). Launched from the toolbar [Install pkg] button or
// from a registry row's [Install] action.
//
// Two paths actually install today:
//   1. Local path — pkgInstallFromPath against a manifest.json directory.
//   2. Registry, pkg-targeted — fetches the per-pkg detail, resolves a
//      dep plan, walks it via pkgInstallFromRegistry. Mirrors the install
//      loop that used to live in the legacy /packages/browse page.
// Manifest URL stays parked; the signed-registry path covers the same need
// with the signature/integrity guarantees baked in.

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/components/ui/utils';
import { pkgInstallFromPath, pkgInstallFromRegistry } from '@/lib/tauri-cmd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import {
	useInstallPlanResolver,
	useRefreshRegistry,
	useRegistryIndex,
	useRegistryPkgDetail,
	type InstallStep,
	type RegistryEntry,
} from '@/lib/registry/use-registry';
import { PkgScreenshotCarousel } from './pkg-screenshots';

type InstallTab = 'manifest-url' | 'local-path' | 'registry';

interface InstallProgress {
	done: number;
	total: number;
	current: string;
}

export function PkgInstallSheet({
	open,
	onOpenChange,
	defaultUrl: _defaultUrl,
	defaultTab = 'manifest-url',
	pkg,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultUrl?: string;
	defaultTab?: InstallTab;
	/**
	 * If set, the sheet opens in "pkg-targeted" mode: hero preview + about
	 * + manifest preview + signed-registry install, instead of the generic
	 * three-tab paste/path/registry form. Comes from clicking [Install] on
	 * a specific registry row.
	 */
	pkg?: PkgRowV2 | null;
}) {
	const qc = useQueryClient();
	const [tab, setTab] = useState<InstallTab>(defaultTab);
	const [path, setPath] = useState('');
	const [url, setUrl] = useState('');
	const [installError, setInstallError] = useState<string | null>(null);
	const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);

	const indexQuery = useRegistryIndex();
	const indexUrl = indexQuery.data?.indexUrl;
	// An already-installed pkg with a newer registry version carries the same
	// `registryEntry` (populated in use-derived) — so the in-place update path
	// reuses this exact sheet + signed dep-plan resolution as a fresh install.
	const isUpdate = Boolean(pkg?.installed && pkg?.latest);
	// Per-pkg detail is fetched only when this sheet is targeting a registry
	// pkg (or an installed pkg with an update) — the catalog row's hero
	// metadata is already enough until the user commits.
	const registryEntry: RegistryEntry | undefined = pkg?.registryEntry ?? undefined;
	const detailQuery = useRegistryPkgDetail(indexUrl, registryEntry);
	const planResolver = useInstallPlanResolver(indexUrl);
	const refreshRegistry = useRefreshRegistry();

	const fromPathMut = useMutation({
		mutationFn: () => pkgInstallFromPath(path),
		onSuccess: () => {
			void qc.refetchQueries({ queryKey: ['pkg'] });
			onOpenChange(false);
		},
		onError: (e) => setInstallError((e as Error).message ?? String(e)),
	});

	const fromRegistryMut = useMutation({
		mutationFn: async () => {
			if (!detailQuery.data) throw new Error('Registry detail not loaded yet');
			const plan: InstallStep[] = await planResolver.mutateAsync({
				root: detailQuery.data,
				// On an update, install exactly the version the index advertised
				// (`pkg.latest`) rather than trusting the detail file's array
				// ordering — deterministic and immune to index/detail drift.
				version: isUpdate ? (pkg?.latest ?? undefined) : undefined,
			});
			let done = 0;
			setInstallProgress({ done: 0, total: plan.length, current: plan[0]?.name ?? '' });
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
			setInstallProgress({ done, total: plan.length, current: pkg?.name ?? '' });
			return done;
		},
		onSuccess: async () => {
			setInstallError(null);
			await qc.invalidateQueries({ queryKey: ['pkg'] });
			refreshRegistry();
			// Brief pause so the user sees the final "N of N" before the sheet closes.
			setTimeout(() => {
				setInstallProgress(null);
				onOpenChange(false);
			}, 800);
		},
		onError: (e) => {
			setInstallError((e as Error).message ?? String(e));
			setInstallProgress(null);
		},
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 border-l border-border !bg-background p-0 text-foreground sm:max-w-[560px]"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex items-center gap-3 border-b border-border bg-muted/40 p-4">
					<div className="grid h-9 w-9 place-items-center rounded-sm border border-border bg-background text-primary">
						<Plus className="h-4.5 w-4.5" />
					</div>
					<div>
						<div className="font-display text-lg font-medium tracking-tight">
							{pkg ? `${isUpdate ? 'Update' : 'Install'} ${pkg.name}` : 'Install pkg'}
						</div>
						<div className="text-[11px] text-muted-foreground/70">
							{pkg
								? isUpdate
									? `${pkg.id}  v${pkg.version} → v${pkg.latest}`
									: `${pkg.id}@${pkg.version}`
								: 'paste a manifest URL or pick from registry'}
						</div>
					</div>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{pkg ? (
					<>
						<div className="flex-1 space-y-5 overflow-y-auto p-5">
							<PkgScreenshotCarousel row={pkg} variant="install-preview" />
							<section className="space-y-2">
								<label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
									about
								</label>
								<p className="text-sm leading-relaxed text-foreground">{pkg.desc || '—'}</p>
							</section>
							{pkg.scopes.length > 0 && (
								<section className="space-y-2">
									<label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										manifest preview · {pkg.id}@{pkg.version}
									</label>
									<dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-xs">
										<dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
											routes
										</dt>
										<dd className="m-0 flex flex-wrap gap-1 font-mono text-muted-foreground">
											{pkg.routes.length ? (
												pkg.routes.map((r) => (
													<code
														key={r}
														className="rounded-sm border border-border bg-background px-1 py-0.5 text-foreground"
													>
														{r}
													</code>
												))
											) : (
												<span className="text-muted-foreground/70">none</span>
											)}
										</dd>
										<dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
											scopes
										</dt>
										<dd className="m-0 flex flex-wrap gap-1 font-mono text-muted-foreground">
											{pkg.scopes.map((s) => {
												const warn = /write|engine|shell\.execute|net:https/.test(s);
												return (
													<span
														key={s}
														className={cn(
															'rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
															warn
																? 'border-destructive/40 bg-destructive/10 text-destructive'
																: 'border-primary/30 bg-primary/10 text-primary'
														)}
													>
														{s}
													</span>
												);
											})}
										</dd>
									</dl>
								</section>
							)}
							{pkg.scopes.some((s) => /^fs:write/.test(s)) && (
								<div className="space-y-1 rounded-sm border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
									<div className="font-medium">Review write scopes</div>
									<p className="text-[12.5px] leading-relaxed">
										This pkg requests write access to{' '}
										{pkg.scopes
											.filter((s) => /^fs:write/.test(s))
											.map((s) => s.replace(/^fs:write:/, ''))
											.join(', ')}
										. Only install if you trust the publisher.
									</p>
								</div>
							)}
							{installError && (
								<div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
									Install failed: {installError}
								</div>
							)}
							{installProgress && <InstallProgressBar progress={installProgress} />}
						</div>
						<div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
							<RegistryStatus
								detailLoading={detailQuery.isLoading}
								detailError={detailQuery.error as Error | null}
								indexError={indexQuery.error as Error | null}
							/>
							<span className="flex-1" />
							<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button
								size="sm"
								disabled={!detailQuery.data || fromRegistryMut.isPending || !!installProgress}
								onClick={() => fromRegistryMut.mutate()}
							>
								<Plus className="mr-1.5 h-3.5 w-3.5" />
								{fromRegistryMut.isPending || installProgress
									? `${isUpdate ? 'Updating' : 'Installing'}… ${installProgress?.done ?? 0}/${installProgress?.total ?? '?'}`
									: `${isUpdate ? 'Update' : 'Install'} ${pkg.name}`}
							</Button>
						</div>
					</>
				) : (
					<>
						<div className="flex gap-0 border-b border-border bg-muted/40 px-5">
							{(['manifest-url', 'local-path', 'registry'] as InstallTab[]).map((id) => (
								<button
									key={id}
									type="button"
									onClick={() => setTab(id)}
									className={cn(
										'border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
										tab === id
											? 'border-primary text-foreground'
											: 'border-transparent text-muted-foreground hover:text-foreground'
									)}
								>
									{id === 'manifest-url'
										? 'Manifest URL'
										: id === 'local-path'
											? 'Local path'
											: 'Registry'}
								</button>
							))}
						</div>

						<div className="flex-1 space-y-5 overflow-y-auto p-5">
							{tab === 'manifest-url' && (
								<section className="space-y-2">
									<label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										manifest URL
									</label>
									<input
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										placeholder="https://pkgs.ikenga.ai/com.royalti.content/0.3.1/manifest.json"
										className="w-full rounded-sm border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary"
									/>
									<p className="text-[11.5px] leading-relaxed text-muted-foreground">
										Paste a JSON manifest URL. The kernel fetches and validates against the schema
										in{' '}
										<code className="rounded-sm bg-background px-1 text-primary">
											@ikenga/contract
										</code>
										. Manifest preview lands in Phase 4.
									</p>
								</section>
							)}
							{tab === 'local-path' && (
								<section className="space-y-2">
									<label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										absolute path
									</label>
									<input
										value={path}
										onChange={(e) => setPath(e.target.value)}
										placeholder="/Users/you/my-pkg"
										className="w-full rounded-sm border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary"
									/>
									<p className="text-[11.5px] leading-relaxed text-muted-foreground">
										Install from a local directory containing a <code>manifest.json</code>. Useful
										for development; the directory must remain at this path.
									</p>
								</section>
							)}
							{tab === 'registry' && (
								<section className="space-y-2 text-sm text-muted-foreground">
									The registry browser opens on /packages?filter=store — close this sheet and pick a
									pkg row's <strong>Install</strong> button to land back in this sheet with the
									manifest pre-loaded.
								</section>
							)}
						</div>

						<div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
							<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							{tab === 'local-path' ? (
								<Button
									size="sm"
									onClick={() => fromPathMut.mutate()}
									disabled={!path || fromPathMut.isPending}
								>
									{fromPathMut.isPending ? 'Installing…' : 'Install'}
								</Button>
							) : tab === 'manifest-url' ? (
								<Button size="sm" disabled title="Use Registry for signed installs">
									Install
								</Button>
							) : null}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

/* ───── Subcomponents ───── */

function InstallProgressBar({ progress }: { progress: InstallProgress }) {
	const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
				<span>
					Installing <span className="text-foreground">{progress.current || '…'}</span>
				</span>
				<span>
					{progress.done} of {progress.total}
				</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full bg-primary transition-all duration-300"
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function RegistryStatus({
	detailLoading,
	detailError,
	indexError,
}: {
	detailLoading: boolean;
	detailError: Error | null;
	indexError: Error | null;
}) {
	if (indexError) {
		return (
			<span className="font-mono text-[10.5px] text-destructive">
				registry unreachable: {indexError.message}
			</span>
		);
	}
	if (detailError) {
		return (
			<span className="font-mono text-[10.5px] text-destructive">
				detail failed: {detailError.message}
			</span>
		);
	}
	if (detailLoading) {
		return <span className="font-mono text-[10.5px] text-muted-foreground">resolving plan…</span>;
	}
	return (
		<span className="font-mono text-[10.5px] text-muted-foreground">
			signature verified · ready
		</span>
	);
}
