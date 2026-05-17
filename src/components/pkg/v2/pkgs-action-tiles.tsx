// Action tiles — the state-led header for the unified pkg surface.
// 4 tiles in the active state; collapses to a single inventory tile when
// nothing is pending.

import { ArrowUp, Ban, ChevronRight, LayoutGrid, Shield } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import type { DerivedPkgs } from '@/lib/pkgs/use-derived';

type Tone = 'attention' | 'warn' | 'quiet';

function Tile({
	tone,
	eyebrow,
	icon,
	headline,
	sub,
	cta,
	onClick,
}: {
	tone: Tone;
	eyebrow: string;
	icon: ReactNode;
	headline: ReactNode;
	sub: ReactNode;
	cta: ReactNode;
	onClick?: () => void;
}) {
	return (
		<div
			role={onClick ? 'button' : undefined}
			onClick={onClick}
			className={cn(
				'grid cursor-pointer content-start gap-2 rounded-md border bg-card p-4 transition-colors',
				tone === 'attention' && 'border-amber-500/30 hover:bg-amber-500/5',
				tone === 'warn' && 'border-red-500/30 hover:bg-red-500/5',
				tone === 'quiet' && 'border-border hover:bg-accent'
			)}
		>
			<div
				className={cn(
					'flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider',
					tone === 'attention' && 'text-amber-500',
					tone === 'warn' && 'text-red-500',
					tone === 'quiet' && 'text-muted-foreground/70'
				)}
			>
				{icon}
				<span>{eyebrow}</span>
			</div>
			<div className="font-display text-3xl font-medium leading-none">
				<em className="not-italic">{headline}</em>
			</div>
			<div className="text-xs leading-snug text-muted-foreground">{sub}</div>
			<div
				className={cn(
					'mt-1 inline-flex items-center gap-1 font-mono text-[11px] tracking-wide',
					tone === 'attention' && 'text-amber-500',
					tone === 'warn' && 'text-red-500',
					tone === 'quiet' && 'text-muted-foreground/70'
				)}
			>
				{cta}
			</div>
		</div>
	);
}

export function PkgsActionTiles({
	d,
	onReviewUpdates,
	onReviewTrust,
	onReviewViolations,
	onBrowseRegistry,
	shellUpdate,
	onShellUpdate,
}: {
	d: DerivedPkgs;
	onReviewUpdates?: () => void;
	onReviewTrust?: () => void;
	onReviewViolations?: () => void;
	onBrowseRegistry?: () => void;
	/** Shell-self update info from useUpdater. When present, the Updates tile
	 *  appends a line summarizing it and deep-links to /settings/about. */
	shellUpdate?: { currentVersion: string; version: string } | null;
	onShellUpdate?: () => void;
}) {
	const totalKnown = d.installed.length + d.registry.length;
	const quiet =
		!d.updates.length && !d.trust.length && !d.violations.length && !shellUpdate;

	if (quiet) {
		return (
			<div className="border-b border-border bg-muted/30 px-6 py-4">
				<Tile
					tone="quiet"
					icon={<Shield className="h-3.5 w-3.5" />}
					eyebrow="Inventory · everything green"
					headline={
						<span className="text-xl">
							{d.installed.length} installed · {d.sidecarsRunning} sidecars running ·{' '}
							{d.registry.length} in registry
						</span>
					}
					sub="No updates available. No trust reviews pending. No permission violations in the last 7 days."
					cta={null}
				/>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-3 border-b border-border bg-muted/30 px-6 py-4 md:grid-cols-2 lg:grid-cols-4">
			<Tile
				tone="attention"
				icon={<ArrowUp className="h-3.5 w-3.5" />}
				eyebrow="Updates available"
				headline={d.updates.length + (shellUpdate ? 1 : 0)}
				sub={
					<>
						{d.updates.length > 0 && (
							<div>
								{d.updates
									.slice(0, 3)
									.map((p) => `${p.name} v${p.version} → v${p.latest}`)
									.join(' · ')}
								{d.updates.length > 3 && ` · +${d.updates.length - 3} more`}
							</div>
						)}
						{shellUpdate && (
							<div
								className={d.updates.length > 0 ? 'mt-1' : ''}
								onClick={(e) => {
									e.stopPropagation();
									onShellUpdate?.();
								}}
								role="link"
								tabIndex={0}
							>
								<span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
									shell
								</span>{' '}
								v{shellUpdate.currentVersion} → v{shellUpdate.version}{' '}
								<span className="text-amber-600 dark:text-amber-400">— About →</span>
							</div>
						)}
						{!d.updates.length && !shellUpdate && 'Nothing to update'}
					</>
				}
				cta={
					<>
						Review &amp; update <ChevronRight className="h-3 w-3" />
					</>
				}
				onClick={onReviewUpdates}
			/>
			<Tile
				tone="warn"
				icon={<Shield className="h-3.5 w-3.5" />}
				eyebrow="Trust reviews"
				headline={d.trust.length}
				sub={
					d.trust.length ? d.trust.map((p) => `${p.name} pending`).join(' · ') : 'Nothing pending'
				}
				cta={<>Review →</>}
				onClick={onReviewTrust}
			/>
			<Tile
				tone="warn"
				icon={<Ban className="h-3.5 w-3.5" />}
				eyebrow="Permission violations"
				headline={d.violations.length}
				sub={
					d.violations.length
						? d.violations
								.map((p) => `${p.name} tried ${p.violations[0]?.scope_kind ?? 'a scope'}`)
								.join(' · ') + ' — denied. Pkg is sandboxed.'
						: 'No recent violations'
				}
				cta={<>View log →</>}
				onClick={onReviewViolations}
			/>
			<Tile
				tone="quiet"
				icon={<LayoutGrid className="h-3.5 w-3.5" />}
				eyebrow="Inventory"
				headline={
					<>
						{d.installed.length}
						<span className="ml-1 text-xl text-muted-foreground">/ {totalKnown}</span>
					</>
				}
				sub={
					<>
						{d.sidecarsRunning} sidecars running · {d.registry.length} available in registry
					</>
				}
				cta={
					<>
						Browse registry <ChevronRight className="h-3 w-3" />
					</>
				}
				onClick={onBrowseRegistry}
			/>
		</div>
	);
}
