// Pkg loupe — right-sliding sheet with tabbed detail.
// Used in place of TrustReviewDialog + ViolationsReviewDialog from the
// current /packages page, and as the install sheet (re-uses the same
// chrome with a registry-specific body).

import { ArrowUp, Ban, Copy, ExternalLink, Plus, Power, Shield, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/components/ui/utils';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import {
	pkgSetEnabled,
	pkgSettingsGet,
	pkgSettingsSet,
	pkgTrustGrant,
	pkgTrustRevoke,
	type PkgSettingsField,
	type PkgSettingsSnapshot,
} from '@/lib/tauri-cmd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dot, OriginChip, StateChip, TrustChip, UpdateChip, ViolationChip } from './atoms';
import { PkgScreenshotCarousel, PkgScreenshotHero } from './pkg-screenshots';
import { classifyScope, riskColor } from './scope-classifier';

export type LoupeTab = 'overview' | 'permissions' | 'trust' | 'settings' | 'manifest';

export interface PkgLoupeProps {
	row: PkgRowV2 | null;
	tab?: LoupeTab;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onInstall?: (row: PkgRowV2) => void;
	onUpdate?: (row: PkgRowV2) => void;
	onUninstall?: (row: PkgRowV2) => void;
}

export function PkgLoupe({
	row,
	tab: initialTab = 'overview',
	open,
	onOpenChange,
	onInstall,
	onUpdate,
	onUninstall,
}: PkgLoupeProps) {
	const [tab, setTab] = useState<LoupeTab>(initialTab);
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 border-l border-border !bg-background p-0 text-foreground sm:max-w-[560px]"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{row ? (
					<>
						<PkgScreenshotHero row={row} />
						<LoupeHead row={row} onClose={() => onOpenChange(false)} />
						<LoupeTabs row={row} tab={tab} onTab={setTab} />
						<div className="flex-1 overflow-y-auto p-5">
							{tab === 'overview' && <TabOverview row={row} />}
							{tab === 'permissions' && <TabPermissions row={row} />}
							{tab === 'trust' && <TabTrust row={row} />}
							{tab === 'settings' && <TabSettings row={row} />}
							{tab === 'manifest' && <TabManifest row={row} />}
						</div>
						<LoupeFoot
							row={row}
							onClose={() => onOpenChange(false)}
							onInstall={onInstall}
							onUpdate={onUpdate}
							onUninstall={onUninstall}
						/>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}

/* ───── Head + Tabs + Foot ───── */

function LoupeHead({ row, onClose }: { row: PkgRowV2; onClose: () => void }) {
	return (
		<div className="flex items-center gap-3 border-b border-border bg-muted/40 p-4">
			<div className="min-w-0">
				<div className="flex items-baseline gap-2">
					<span className="font-display text-lg font-medium tracking-tight">{row.name}</span>
					<span className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
						v{row.version}
					</span>
				</div>
				<div className="truncate font-mono text-[11px] text-muted-foreground/70">{row.id}</div>
			</div>
			<button
				type="button"
				onClick={onClose}
				className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				aria-label="Close"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

function LoupeTabs({
	row,
	tab,
	onTab,
}: {
	row: PkgRowV2;
	tab: LoupeTab;
	onTab: (t: LoupeTab) => void;
}) {
	const items: Array<{ id: LoupeTab; label: string; count?: number; pending?: boolean }> = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'permissions', label: 'Permissions', count: row.scopes.length },
		{ id: 'trust', label: 'Trust', pending: row.trust?.state === 'needs_approval' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'manifest', label: 'Manifest' },
	];
	return (
		<div className="flex gap-0 border-b border-border bg-muted/40 px-5">
			{items.map((it) => (
				<button
					key={it.id}
					type="button"
					onClick={() => onTab(it.id)}
					className={cn(
						'border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
						tab === it.id
							? 'border-primary text-foreground'
							: 'border-transparent text-muted-foreground hover:text-foreground'
					)}
				>
					{it.label}
					{typeof it.count === 'number' && (
						<span className="ml-1 font-mono text-[10px] text-muted-foreground/70">{it.count}</span>
					)}
					{it.pending && <span className="ml-1 text-[11px] text-red-500">· pending</span>}
				</button>
			))}
		</div>
	);
}

function LoupeFoot({
	row,
	onClose,
	onInstall,
	onUpdate,
	onUninstall,
}: {
	row: PkgRowV2;
	onClose: () => void;
	onInstall?: (row: PkgRowV2) => void;
	onUpdate?: (row: PkgRowV2) => void;
	onUninstall?: (row: PkgRowV2) => void;
}) {
	const qc = useQueryClient();
	const grantMut = useMutation({
		mutationFn: () => pkgTrustGrant(row.id, row.version),
		onSuccess: () => qc.refetchQueries({ queryKey: ['pkg'] }),
	});
	const enableMut = useMutation({
		mutationFn: () => pkgSetEnabled(row.id, !row.enabled),
		onSuccess: () => qc.refetchQueries({ queryKey: ['pkg'] }),
	});

	return (
		<div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
			{row.origin === 'registry' ? (
				<>
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
					<Button size="sm" onClick={() => onInstall?.(row)}>
						<Plus className="mr-1.5 h-3.5 w-3.5" />
						Install
					</Button>
				</>
			) : row.latest && row.latest !== row.version ? (
				<>
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
					<Button
						size="sm"
						className="bg-amber-500 text-amber-950 hover:bg-amber-500/90"
						onClick={() => onUpdate?.(row)}
					>
						<ArrowUp className="mr-1.5 h-3.5 w-3.5" />
						Update to v{row.latest}
					</Button>
				</>
			) : row.trust?.state === 'needs_approval' ? (
				<>
					<Button size="sm" variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="outline"
						className="border-red-500/40 text-red-500 hover:bg-red-500/10"
						disabled={grantMut.isPending}
						onClick={() => grantMut.mutate()}
					>
						<Shield className="mr-1.5 h-3.5 w-3.5" />
						{grantMut.isPending ? 'Approving…' : `Approve v${row.version}`}
					</Button>
				</>
			) : (
				<>
					{row.origin !== 'builtin' && onUninstall && (
						<Button
							size="sm"
							variant="ghost"
							className="text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
							onClick={() => onUninstall(row)}
						>
							<Ban className="mr-1.5 h-3.5 w-3.5" />
							Uninstall
						</Button>
					)}
					<Button
						size="sm"
						variant="outline"
						disabled={enableMut.isPending}
						onClick={() => enableMut.mutate()}
					>
						<Power className="mr-1.5 h-3.5 w-3.5" />
						{row.enabled ? 'Disable' : 'Enable'}
					</Button>
				</>
			)}
		</div>
	);
}

/* ───── Tab bodies ───── */

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
			{children}
		</div>
	);
}

function TabOverview({ row }: { row: PkgRowV2 }) {
	return (
		<div className="space-y-5">
			{row.trust?.state === 'needs_approval' && <TrustCallout row={row} />}
			{row.violations.length > 0 && <ViolationCallout row={row} />}
			<section className="space-y-2">
				<SectionLabel>about</SectionLabel>
				<p className="text-sm leading-relaxed text-foreground">{row.desc || '—'}</p>
				<div className="flex flex-wrap gap-1.5">
					<OriginChip origin={row.origin} />
					<StateChip state={row.state} />
					<UpdateChip row={row} />
					<TrustChip row={row} />
					<ViolationChip row={row} />
				</div>
			</section>
			<PkgScreenshotCarousel row={row} />
			<section className="space-y-2">
				<SectionLabel>manifest summary</SectionLabel>
				<MetaGrid
					rows={[
						['kind', <code key="k">{row.kind}</code>],
						[
							'routes',
							row.routes.length ? (
								<div className="flex flex-wrap gap-1">
									{row.routes.map((r) => (
										<code key={r}>{r}</code>
									))}
								</div>
							) : (
								<span className="text-muted-foreground/70">none</span>
							),
						],
						[
							'sidecars',
							row.sidecars.length ? (
								<div className="flex flex-wrap gap-1">
									{row.sidecars.map((s) => (
										<code key={s}>{s}</code>
									))}
								</div>
							) : (
								<span className="text-muted-foreground/70">none</span>
							),
						],
						[
							'install',
							<code key="i" className="break-all">
								{row.installPath}
							</code>,
						],
						...(row.installedAt
							? ([['added', new Date(row.installedAt * 1000).toISOString().slice(0, 10)]] as Array<
									[string, React.ReactNode]
								>)
							: []),
					]}
				/>
			</section>
		</div>
	);
}

function TabPermissions({ row }: { row: PkgRowV2 }) {
	if (!row.scopes.length) {
		return (
			<p className="text-sm text-muted-foreground">This pkg requests no sensitive permissions.</p>
		);
	}
	const high = row.scopes.filter((s) => classifyScope(s).risk === 'high').length;
	return (
		<div className="space-y-5">
			<section className="space-y-2">
				<SectionLabel>
					declared scopes · {row.scopes.length}
					{high > 0 && ` · ${high} high-risk`}
				</SectionLabel>
				<div className="space-y-1.5">
					{row.scopes.map((s) => {
						const c = classifyScope(s);
						return (
							<div
								key={s}
								className="grid grid-cols-[8px_1fr_auto] items-center gap-3 rounded-sm border border-border bg-background px-3 py-2"
							>
								<span
									className={cn(
										'h-1.5 w-1.5 rounded-full',
										riskColor(c.risk).replace('text-', 'bg-')
									)}
								/>
								<div>
									<div className="font-mono text-xs text-foreground">{s}</div>
									<div className="text-[11px] text-muted-foreground">{c.label}</div>
								</div>
								<span
									className={cn(
										'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase',
										c.risk === 'high'
											? 'border-red-500/40 bg-red-500/10 text-red-500'
											: c.risk === 'med'
												? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
												: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
									)}
								>
									risk: {c.risk}
								</span>
							</div>
						);
					})}
				</div>
			</section>
			{row.violations.length > 0 && (
				<section className="space-y-2">
					<SectionLabel>recent violations</SectionLabel>
					{row.violations.map((v) => (
						<div
							key={v.id}
							className="space-y-1 rounded-sm border border-red-500/30 bg-red-500/5 px-3 py-2"
						>
							<div className="text-sm font-medium text-red-500">
								Denied:{' '}
								<code className="rounded-sm bg-background px-1 py-0.5 text-foreground">
									{v.scope_kind}
								</code>
							</div>
							<div className="text-[11px] text-muted-foreground">
								attempted{' '}
								<code className="rounded-sm bg-background px-1 text-foreground">{v.attempted}</code>{' '}
								· declared{' '}
								<code className="rounded-sm bg-background px-1 text-foreground">{v.declared}</code>{' '}
								· {new Date(v.occurred_at * 1000).toISOString().slice(0, 19).replace('T', ' ')}
							</div>
						</div>
					))}
				</section>
			)}
		</div>
	);
}

function TabTrust({ row }: { row: PkgRowV2 }) {
	const t = row.trust;
	const qc = useQueryClient();
	const revokeMut = useMutation({
		mutationFn: () => pkgTrustRevoke(row.id),
		onSuccess: () => qc.refetchQueries({ queryKey: ['pkg'] }),
	});

	let label = 'Unknown';
	let sub = 'Not yet installed.';
	let tone: 'live' | 'warn' | 'danger' | 'muted' = 'muted';
	if (t?.state === 'auto_trusted') {
		label = 'Auto-trusted';
		sub = `Built-in pkg in the com.ikenga.* namespace. Cannot be revoked.`;
		tone = 'live';
	} else if (t?.state === 'auto_granted') {
		label = 'Auto-granted';
		sub = `Skill-only pkg with no sensitive perms. Auto-approved on install.`;
		tone = 'live';
	} else if (t?.state === 'granted') {
		label = 'Trusted';
		sub = `You approved this pkg on install. Permissions are honored.`;
		tone = 'live';
	} else if (t?.state === 'needs_approval') {
		label = 'Pending review';
		const change = t.change_reason;
		if (change?.kind === 'permissions_changed') {
			sub = `Bumped from v${change.prior_version}. Added: ${change.added.join(', ') || '(none)'}. Re-approve before enabling.`;
		} else if (change?.kind === 'revoked') {
			sub = `Trust was revoked. Re-approve to grant declared permissions again.`;
		} else {
			sub = `A change to this pkg requires your re-approval.`;
		}
		tone = 'danger';
	}

	return (
		<div className="space-y-5">
			<section className="space-y-2">
				<SectionLabel>current trust state</SectionLabel>
				<div className="space-y-2 rounded-sm border border-border bg-background p-4">
					<div className="flex items-center gap-2 font-display text-lg font-medium">
						<Dot tone={tone} />
						{label}
					</div>
					<p className="text-sm leading-relaxed text-muted-foreground">{sub}</p>
					{t?.state === 'granted' && (
						<Button
							size="sm"
							variant="ghost"
							className="mt-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
							disabled={revokeMut.isPending}
							onClick={() => revokeMut.mutate()}
						>
							<Ban className="mr-1.5 h-3.5 w-3.5" />
							Revoke trust
						</Button>
					)}
				</div>
			</section>
			<section className="space-y-2">
				<SectionLabel>trust log</SectionLabel>
				<div className="space-y-1.5 font-mono text-[11.5px]">
					{row.installedAt && (
						<div className="text-muted-foreground">
							<Dot tone="live" />{' '}
							<span className="ml-2">
								{new Date(row.installedAt * 1000).toISOString().slice(0, 10)} · v{row.version}{' '}
								installed
							</span>
						</div>
					)}
					{t?.last_granted_at_ms && (
						<div className="text-muted-foreground">
							<Dot tone="live" />{' '}
							<span className="ml-2">
								{new Date(t.last_granted_at_ms).toISOString().slice(0, 10)} · trust granted
							</span>
						</div>
					)}
					{row.violations.map((v) => (
						<div key={v.id} className="text-red-500">
							<Dot tone="danger" />{' '}
							<span className="ml-2">
								{new Date(v.occurred_at * 1000).toISOString().slice(0, 10)} · attempted{' '}
								<code>{v.scope_kind}</code> — denied
							</span>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

function TabSettings({ row }: { row: PkgRowV2 }) {
	const qc = useQueryClient();
	const settings = useQuery({
		enabled: row.origin !== 'registry',
		queryKey: ['pkg', 'settings', row.id],
		queryFn: () => pkgSettingsGet(row.id),
	});

	if (row.origin === 'registry') {
		return <p className="text-sm text-muted-foreground">Install the pkg to configure it.</p>;
	}
	if (settings.isLoading) {
		return <p className="text-sm text-muted-foreground">Loading settings…</p>;
	}
	if (settings.error) {
		return (
			<p className="text-sm text-red-500">
				Failed to load settings: {(settings.error as Error).message}
			</p>
		);
	}
	const snapshot: PkgSettingsSnapshot | undefined = settings.data;
	const schema = (snapshot?.schema as PkgSettingsField[] | undefined) ?? [];
	if (!schema.length) {
		return (
			<p className="text-sm text-muted-foreground">This pkg has no user-configurable settings.</p>
		);
	}
	return (
		<div className="space-y-5">
			{schema.map((field) => (
				<SettingField
					key={field.key}
					field={field}
					value={(snapshot?.values as Record<string, unknown> | undefined)?.[field.key]}
					onChange={async (value) => {
						await pkgSettingsSet(row.id, field.key, value);
						await qc.refetchQueries({ queryKey: ['pkg', 'settings', row.id] });
					}}
				/>
			))}
		</div>
	);
}

function SettingField({
	field,
	value,
	onChange,
}: {
	field: PkgSettingsField;
	value: unknown;
	onChange: (v: unknown) => Promise<void> | void;
}) {
	const current = value ?? field.default ?? '';
	return (
		<section className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-2">
				<div className="text-sm font-medium text-foreground">{field.label ?? field.key}</div>
				<code className="font-mono text-[10px] text-muted-foreground/70">{field.key}</code>
			</div>
			{field.type === 'bool' ? (
				<button
					type="button"
					onClick={() => onChange(!current)}
					className={cn(
						'inline-flex h-7 items-center rounded-sm border px-2 font-mono text-xs',
						current ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-500' : 'border-border'
					)}
				>
					{current ? '☑ on' : '☐ off'}
				</button>
			) : (
				<input
					defaultValue={String(current)}
					onBlur={(e) => onChange(e.target.value)}
					className="w-full rounded-sm border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary"
				/>
			)}
			{field.description && (
				<p className="text-[11px] text-muted-foreground">{field.description}</p>
			)}
		</section>
	);
}

function TabManifest({ row }: { row: PkgRowV2 }) {
	const json = JSON.stringify(row.manifest ?? { id: row.id, version: row.version }, null, 2);
	return (
		<section className="space-y-2">
			<SectionLabel>
				manifest.json · {row.id}@{row.version}
			</SectionLabel>
			<pre className="overflow-x-auto rounded-sm border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
				{json}
			</pre>
			<div className="flex gap-1.5">
				<Button
					size="sm"
					variant="outline"
					className="h-7"
					onClick={() => void navigator.clipboard?.writeText(json)}
				>
					<Copy className="mr-1.5 h-3.5 w-3.5" />
					Copy
				</Button>
				<Button size="sm" variant="ghost" className="h-7 text-muted-foreground">
					<ExternalLink className="mr-1.5 h-3.5 w-3.5" />
					Open in editor
				</Button>
			</div>
		</section>
	);
}

/* ───── Shared bits ───── */

function MetaGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
	return (
		<dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-xs">
			{rows.flatMap(([k, v], i) => [
				<dt
					key={`${k}-${i}-k`}
					className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70"
				>
					{k}
				</dt>,
				<dd
					key={`${k}-${i}-v`}
					className="m-0 flex flex-wrap items-center gap-1 font-mono text-muted-foreground [&_code]:rounded-sm [&_code]:border [&_code]:border-border [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground"
				>
					{v}
				</dd>,
			])}
		</dl>
	);
}

function TrustCallout({ row }: { row: PkgRowV2 }) {
	const change = row.trust?.change_reason;
	let note = 'A change to this pkg requires your re-approval.';
	if (change?.kind === 'permissions_changed') {
		note = `Bumped from v${change.prior_version}. Added: ${change.added.join(', ') || '(none)'}. Re-approve before enabling.`;
	}
	return (
		<div className="space-y-1 rounded-sm border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
			<div className="font-medium">Trust review needed</div>
			<p className="text-[12.5px] leading-relaxed">{note}</p>
		</div>
	);
}

function ViolationCallout({ row }: { row: PkgRowV2 }) {
	const v = row.violations[0];
	return (
		<div className="space-y-1 rounded-sm border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
			<div className="font-medium">Permission violation</div>
			<p className="text-[12.5px] leading-relaxed">
				Attempted{' '}
				<code className="rounded-sm bg-background px-1 text-foreground">{v.scope_kind}</code> (
				<code className="rounded-sm bg-background px-1 text-foreground">{v.attempted}</code>) —
				denied at {new Date(v.occurred_at * 1000).toISOString().slice(0, 19).replace('T', ' ')}. No
				action required; pkg is sandboxed.
			</p>
		</div>
	);
}
