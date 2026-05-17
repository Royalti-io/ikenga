// Install sheet — re-uses the loupe chrome with three tabs (Manifest URL ·
// Local path · Registry). Launched from the toolbar [Install pkg] button or
// from a registry row's [Install] action.
//
// This is a thin first-cut that wires the existing tauri commands; the
// richer manifest-preview UI from the current /install route is folded in
// during Phase 4.

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/components/ui/utils';
import { pkgInstallFromPath } from '@/lib/tauri-cmd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import { PkgScreenshotCarousel } from './pkg-screenshots';

type InstallTab = 'manifest-url' | 'local-path' | 'registry';

export function PkgInstallSheet({
	open,
	onOpenChange,
	defaultUrl,
	defaultTab = 'manifest-url',
	pkg,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultUrl?: string;
	defaultTab?: InstallTab;
	/**
	 * If set, the sheet opens in "pkg-targeted" mode: hero preview + about
	 * + manifest preview, instead of the generic three-tab paste/path/registry
	 * form. Comes from clicking [Install] on a specific registry row.
	 */
	pkg?: PkgRowV2 | null;
}) {
	const qc = useQueryClient();
	const [tab, setTab] = useState<InstallTab>(defaultTab);
	const [url, setUrl] = useState(defaultUrl ?? '');
	const [path, setPath] = useState('');

	const fromPathMut = useMutation({
		mutationFn: () => pkgInstallFromPath(path),
		onSuccess: () => {
			void qc.refetchQueries({ queryKey: ['pkg'] });
			onOpenChange(false);
		},
	});
	// Manifest-URL install requires fetching the manifest first to extract
	// the tarball URL + integrity hash. That wiring lands in Phase 4.

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
							{pkg ? `Install ${pkg.name}` : 'Install pkg'}
						</div>
						<div className="text-[11px] text-muted-foreground/70">
							{pkg ? `${pkg.id}@${pkg.version}` : 'paste a manifest URL or pick from registry'}
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
																? 'border-red-500/40 bg-red-500/10 text-red-500'
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
								<div className="space-y-1 rounded-sm border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
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
						</div>
						<div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
							<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button size="sm" disabled title="Registry install wiring lands in Phase 4">
								<Plus className="mr-1.5 h-3.5 w-3.5" />
								Install {pkg.name}
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
								<Button size="sm" disabled title="Phase 4 wiring in progress">
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
