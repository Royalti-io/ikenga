// Step 4 — App packages picker.
//
// Renders a grid of pkg cards from `ONBOARDING_PKG_CATALOG`. Selection
// state lives on the wizard payload (so re-entry from Settings preserves
// it). A side strip below the grid surfaces the live preview of which
// connectors will be required (computed via `resolveRequiredConnectors`)
// so the user can see "if I pick this, I'll need Supabase".
//
// No pkg install happens here — selection is persisted and the install
// runs after the Connectors step, so connectors are configured before
// pkgs try to use them.
//
// Mirrors prototypes `04-packages.html` + `04-packages-cloud-disabled.html`.

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { findConnector } from '@/lib/onboarding/connectors';
import {
	BUCKET_LABEL,
	type CatalogIconKey,
	type CatalogTrafficLight,
	countByBucket,
	defaultSelectedIds,
	ONBOARDING_PKG_CATALOG,
	type OnboardingPkgEntry,
} from '@/lib/onboarding/pkg-catalog';
import {
	type ConnectorRequirement,
	resolveRequiredConnectors,
} from '@/lib/onboarding/resolve-connectors';

import { useOnboardingStep } from './use-onboarding-step';

export interface PackagesStepPayload {
	/** Pkg ids the user has chosen to install. Drives the Connectors step. */
	selected: string[];
}

interface PackagesBodyProps {
	onContinue: () => void;
}

type Filter = CatalogTrafficLight | 'all';

const FILTER_ORDER: readonly Filter[] = ['all', 'local-only', 'needs-cloud', 'engine'];

const ICON_GLYPH: Record<CatalogIconKey, string> = {
	studio: '▶',
	tasks: '◧',
	mail: '✉',
	outbound: '↗',
	content: '✎',
	sales: '$',
	files: '⎘',
	engine: '⌘',
};

const ICON_BG: Record<CatalogIconKey, { bg: string; fg: string }> = {
	studio: { bg: 'hsl(8,60%,90%)', fg: 'hsl(8,70%,32%)' },
	tasks: { bg: 'hsl(220,30%,90%)', fg: 'hsl(220,60%,35%)' },
	mail: { bg: 'hsl(42,60%,88%)', fg: 'hsl(42,80%,30%)' },
	outbound: { bg: 'hsl(14,60%,90%)', fg: 'hsl(14,70%,32%)' },
	content: { bg: 'hsl(170,30%,88%)', fg: 'hsl(170,50%,24%)' },
	sales: { bg: 'hsl(220,20%,88%)', fg: 'hsl(220,30%,24%)' },
	files: { bg: 'hsl(28,28%,88%)', fg: 'hsl(28,60%,28%)' },
	engine: { bg: 'hsl(28,40%,90%)', fg: 'hsl(20,60%,32%)' },
};

export function PackagesBody({ onContinue }: PackagesBodyProps) {
	const { record, setPayload } = useOnboardingStep<PackagesStepPayload>('packages');
	const persisted = record.payload?.selected;
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(persisted ?? defaultSelectedIds())
	);
	const [filter, setFilter] = useState<Filter>('all');

	// Lazily write the default selection into the store the first time we
	// render — otherwise the Connectors step sees an empty payload until
	// the user touches a card. Guard with a ref so we only do this once.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current) return;
		seededRef.current = true;
		if (!persisted) {
			setPayload({ selected: Array.from(selected).sort() });
		}
	}, [persisted, selected, setPayload]);

	const buckets = useMemo(countByBucket, []);

	const requirements = useMemo(
		() =>
			resolveRequiredConnectors(
				selected,
				ONBOARDING_PKG_CATALOG.map((p) => p.manifest)
			),
		[selected]
	);

	const sizeTotal = useMemo(() => {
		let total = 0;
		for (const entry of ONBOARDING_PKG_CATALOG) {
			if (selected.has(entry.manifest.id) && entry.sizeMb) {
				total += entry.sizeMb;
			}
		}
		return total;
	}, [selected]);

	const visiblePkgs = useMemo(() => {
		if (filter === 'all') return ONBOARDING_PKG_CATALOG;
		return ONBOARDING_PKG_CATALOG.filter((p) => p.bucket === filter);
	}, [filter]);

	const toggle = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			setPayload({ selected: Array.from(next).sort() });
			return next;
		});
	};

	return (
		<div className="mx-auto max-w-6xl" data-testid="packages-body">
			<div className="mb-6 flex items-end justify-between gap-6">
				<div>
					<p
						className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
						style={{ color: 'var(--primary)' }}
					>
						Pick your apps
					</p>
					<h1 className="text-3xl font-bold leading-tight tracking-tight">
						Which mini-apps should ship with your workspace?
					</h1>
					<p className="mt-2 max-w-[60ch] text-sm" style={{ color: 'var(--fg-muted)' }}>
						Each is a self-contained pkg with its own update channel. Add, remove, or update any of
						them later from <span className="font-mono text-xs">Settings → Packages</span>.
					</p>
				</div>
			</div>

			{/* Filter bar */}
			<div
				className="mb-5 inline-flex w-fit items-center gap-1 rounded-md border p-1"
				style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
				role="tablist"
				aria-label="Filter packages"
			>
				{FILTER_ORDER.map((f) => {
					const label = f === 'all' ? 'All' : BUCKET_LABEL[f];
					const count = buckets[f];
					const on = filter === f;
					return (
						<button
							key={f}
							type="button"
							role="tab"
							aria-selected={on}
							onClick={() => setFilter(f)}
							data-testid={`packages-filter-${f}`}
							className={cn(
								'h-7 rounded-sm px-3 text-xs font-medium transition-colors',
								on ? 'shadow-sm' : ''
							)}
							style={{
								background: on ? 'var(--bg-base)' : 'transparent',
								color: on ? 'var(--fg)' : 'var(--fg-muted)',
								fontWeight: on ? 600 : 500,
							}}
						>
							{label} · {count}
						</button>
					);
				})}
			</div>

			{/* Pkg grid */}
			<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="packages-grid">
				{visiblePkgs.map((entry) => (
					<PkgCard
						key={entry.manifest.id}
						entry={entry}
						selected={selected.has(entry.manifest.id)}
						onToggle={() => toggle(entry.manifest.id)}
					/>
				))}
			</div>

			{/* Live connector preview */}
			<RequiredConnectorsPreview requirements={requirements} />

			{/* Inline continue */}
			<div className="mt-8 flex items-center justify-between gap-3">
				<span className="font-mono text-xs" style={{ color: 'var(--fg-faint)' }}>
					{selected.size} of {ONBOARDING_PKG_CATALOG.length} selected
					{sizeTotal > 0 ? ` · ≈${sizeTotal.toFixed(1)} MB to download` : ''}
				</span>
				<Button
					onClick={onContinue}
					disabled={selected.size === 0}
					data-testid="packages-inline-continue"
				>
					{selected.size === 0 ? 'Pick at least one pkg' : 'Continue'}
				</Button>
			</div>
		</div>
	);
}

interface PkgCardProps {
	entry: OnboardingPkgEntry;
	selected: boolean;
	onToggle: () => void;
}

function PkgCard({ entry, selected, onToggle }: PkgCardProps) {
	const colors = ICON_BG[entry.icon];
	const requiredConnectors = useMemo(
		() => resolveRequiredConnectors([entry.manifest.id], [entry.manifest]),
		[entry]
	);
	return (
		<button
			type="button"
			onClick={onToggle}
			data-testid="pkg-card"
			data-pkg-id={entry.manifest.id}
			data-selected={selected}
			className={cn(
				'relative flex min-h-[180px] flex-col gap-3 rounded-lg border p-4 text-left transition-colors',
				selected ? 'shadow-sm' : 'hover:border-[var(--border-strong)]'
			)}
			style={{
				borderColor: selected ? 'var(--primary)' : 'var(--border-soft)',
				background: 'var(--bg-surface)',
				boxShadow: selected ? '0 0 0 1px var(--primary)' : undefined,
			}}
		>
			{selected && (
				<span
					className="absolute right-2.5 top-2.5 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-bold"
					style={{ background: 'var(--primary)', color: 'var(--primary-fg, white)' }}
					aria-hidden="true"
				>
					✓
				</span>
			)}
			<div className="flex items-start gap-3">
				<div
					className="flex h-8 w-8 flex-none items-center justify-center rounded-sm font-mono text-sm"
					style={{ background: colors.bg, color: colors.fg }}
					aria-hidden="true"
				>
					{ICON_GLYPH[entry.icon]}
				</div>
				<div className="min-w-0">
					<div className="text-[13.5px] font-bold leading-tight">{entry.display}</div>
					<div className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--fg-faint)' }}>
						{entry.manifest.id} · {entry.version}
					</div>
				</div>
			</div>
			<div className="flex-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
				{entry.summary}
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{entry.bucket === 'local-only' && <Pill tone="success">local-only</Pill>}
				{entry.bucket === 'engine' && <Pill tone="primary">engine</Pill>}
				{requiredConnectors.map((req) => {
					const def = findConnector(req.connectorId);
					return (
						<Pill key={req.connectorId} tone="warning">
							needs {def?.display ?? req.connectorId}
						</Pill>
					);
				})}
				{entry.sizeMb && <Pill tone="muted">{entry.sizeMb.toFixed(1)} MB</Pill>}
			</div>
		</button>
	);
}

interface RequiredConnectorsPreviewProps {
	requirements: readonly ConnectorRequirement[];
}

function RequiredConnectorsPreview({ requirements }: RequiredConnectorsPreviewProps) {
	if (requirements.length === 0) {
		return (
			<div
				className="mt-6 rounded-md border border-dashed p-4 text-sm"
				style={{ borderColor: 'var(--border-soft)', color: 'var(--fg-muted)' }}
				data-testid="connector-preview-empty"
			>
				No connectors required for your current selection — the next step will skip itself.
			</div>
		);
	}
	return (
		<div
			className="mt-6 rounded-md border p-4"
			style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
			data-testid="connector-preview"
		>
			<div
				className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em]"
				style={{ color: 'var(--fg-faint)' }}
			>
				Connectors you'll set up next
			</div>
			<div className="flex flex-wrap gap-2">
				{requirements.map((req) => {
					const def = findConnector(req.connectorId);
					return (
						<div
							key={req.connectorId}
							className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px]"
							style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-base)' }}
							data-testid={`connector-chip-${req.connectorId}`}
						>
							<span className="font-semibold">{def?.display ?? req.connectorId}</span>
							<span className="font-mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
								{req.requiredBy.length} pkg{req.requiredBy.length === 1 ? '' : 's'}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function Pill({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: 'success' | 'warning' | 'primary' | 'muted';
}) {
	const palette: Record<typeof tone, { bg: string; fg: string }> = {
		success: { bg: 'var(--success-soft, var(--bg-raised))', fg: 'var(--success, var(--fg))' },
		warning: { bg: 'var(--warning-soft, var(--bg-raised))', fg: 'var(--warning, var(--fg))' },
		primary: { bg: 'var(--primary-soft, var(--bg-raised))', fg: 'var(--primary)' },
		muted: { bg: 'var(--bg-raised)', fg: 'var(--fg-muted)' },
	};
	const c = palette[tone];
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
			style={{ background: c.bg, color: c.fg }}
		>
			{children}
		</span>
	);
}

// ── Pure helpers exposed for tests ─────────────────────────────────────

/**
 * Compute the connector preview that the side-panel renders for a given
 * pkg selection. Kept as a named helper so the tests don't have to
 * mount the full body to verify "selection changes preview".
 */
export function previewForSelection(selectedIds: readonly string[]): ConnectorRequirement[] {
	return resolveRequiredConnectors(
		selectedIds,
		ONBOARDING_PKG_CATALOG.map((p) => p.manifest)
	);
}
