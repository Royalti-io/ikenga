// Step 5 — Dynamic connector substeps.
//
// Reads the pkg selection from step 4's payload, resolves which connectors
// the user needs to configure, and renders a vertical list of "Configure X"
// sections — one per connector. Each section is its own form with field-
// level "saved" affordances; the connector is `configured` once all
// required fields have been written.
//
// Skipping a connector is allowed (the corresponding pkg installs in a
// `disabled` state — Settings → Integrations surfaces an actionable card
// for it post-wizard via the same resolver).
//
// Mirrors prototypes `05-connectors-supabase.html`, `05-connectors-resend.html`,
// `05-connectors-listmonk.html`.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	CONNECTOR_REGISTRY,
	type ConnectorDef,
	type ConnectorId,
	type ConnectorStatus,
	type ConnectorTestResult,
	findConnector,
} from '@/lib/onboarding/connectors';
import { findCatalogEntry, ONBOARDING_PKG_CATALOG } from '@/lib/onboarding/pkg-catalog';
import {
	type ConnectorRequirement,
	resolveRequiredConnectors,
} from '@/lib/onboarding/resolve-connectors';

import type { PackagesStepPayload } from './packages-body';
import { useOnboardingStep } from './use-onboarding-step';

export interface ConnectorsStepPayload {
	/** Connectors the user explicitly configured (vault writes succeeded). */
	configured: ConnectorId[];
	/** Connectors the user opted to skip during this run. */
	skipped: ConnectorId[];
}

interface ConnectorsBodyProps {
	onContinue: () => void;
	onSkip: () => void;
}

const CONNECTOR_STATUS_KEY = ['onboarding', 'connector-status'] as const;

export function ConnectorsBody({ onContinue, onSkip }: ConnectorsBodyProps) {
	const { record: pkgRecord } = useOnboardingStep<PackagesStepPayload>('packages');
	const { record, setPayload } = useOnboardingStep<ConnectorsStepPayload>('connectors');
	const persisted = record.payload ?? { configured: [], skipped: [] };

	const selectedPkgIds = pkgRecord.payload?.selected ?? [];
	const requirements = useMemo(
		() =>
			resolveRequiredConnectors(
				selectedPkgIds,
				ONBOARDING_PKG_CATALOG.map((p) => p.manifest)
			),
		[selectedPkgIds]
	);

	// Refresh on every render of this step — the user can save → re-test
	// → save again; the badge should reflect reality.
	const statuses = useQuery({
		queryKey: [...CONNECTOR_STATUS_KEY, requirements.map((r) => r.connectorId).join(',')],
		queryFn: async () => {
			const out: Partial<Record<ConnectorId, ConnectorStatus>> = {};
			for (const req of requirements) {
				const def = findConnector(req.connectorId);
				if (!def) continue;
				try {
					out[req.connectorId] = await def.status();
				} catch {
					out[req.connectorId] = 'not_configured';
				}
			}
			return out;
		},
		staleTime: 0,
		refetchOnWindowFocus: false,
	});

	// Auto-skip the step when nothing is required. We mark the step as
	// skipped (no payload, no connectors configured) and bounce to the
	// next step. Wizard chrome treats `skipped` like `completed` for nav
	// math; the summary step shows "no connectors required" instead of a
	// configured list. Guarded by a ref so re-renders don't reskip after
	// the user goes Back into this step from a later one.
	const autoSkippedRef = useRef(false);
	useEffect(() => {
		if (autoSkippedRef.current) return;
		if (requirements.length === 0) {
			autoSkippedRef.current = true;
			setPayload({ configured: [], skipped: [] });
			onSkip();
		}
	}, [requirements.length, setPayload, onSkip]);

	const skippedSet = useMemo(() => new Set(persisted.skipped), [persisted.skipped]);
	const configuredSet = useMemo(() => new Set(persisted.configured), [persisted.configured]);

	const allHandled = requirements.every(
		(r) =>
			skippedSet.has(r.connectorId) ||
			configuredSet.has(r.connectorId) ||
			(statuses.data?.[r.connectorId] ?? 'not_configured') === 'configured'
	);

	const handleConfigured = (id: ConnectorId) => {
		const next: ConnectorsStepPayload = {
			configured: Array.from(new Set([...persisted.configured, id])).sort(),
			skipped: persisted.skipped.filter((x) => x !== id),
		};
		setPayload(next);
		void statuses.refetch();
	};

	const handleSkip = (id: ConnectorId) => {
		const next: ConnectorsStepPayload = {
			configured: persisted.configured.filter((x) => x !== id),
			skipped: Array.from(new Set([...persisted.skipped, id])).sort(),
		};
		setPayload(next);
	};

	if (requirements.length === 0) {
		// The effect above is bouncing us out — render nothing to avoid a
		// frame of "no connectors required" flash.
		return null;
	}

	return (
		<div
			className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[240px_1fr]"
			data-testid="connectors-body"
		>
			<aside className="lg:sticky lg:top-0 lg:self-start">
				<div
					className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em]"
					style={{ color: 'var(--fg-faint)' }}
				>
					Connectors
				</div>
				<ol className="space-y-1">
					{requirements.map((req, idx) => {
						const status =
							configuredSet.has(req.connectorId) || skippedSet.has(req.connectorId)
								? configuredSet.has(req.connectorId)
									? 'configured'
									: 'skipped'
								: (statuses.data?.[req.connectorId] ?? 'not_configured');
						return (
							<SubstepItem
								key={req.connectorId}
								index={idx + 1}
								requirement={req}
								status={status}
							/>
						);
					})}
				</ol>
				<p className="mt-4 text-[11px] leading-relaxed" style={{ color: 'var(--fg-faint)' }}>
					Keys are stored in Stronghold, never in <span className="font-mono">.env</span> files.
				</p>
			</aside>

			<div className="space-y-10">
				{requirements.map((req) => {
					const def = findConnector(req.connectorId);
					if (!def) return null;
					return (
						<ConnectorSection
							key={req.connectorId}
							connector={def}
							requirement={req}
							liveStatus={statuses.data?.[req.connectorId]}
							isSkipped={skippedSet.has(req.connectorId)}
							isConfigured={configuredSet.has(req.connectorId)}
							onConfigured={() => handleConfigured(req.connectorId)}
							onSkip={() => handleSkip(req.connectorId)}
						/>
					);
				})}

				<div
					className="sticky bottom-0 -mx-2 flex items-center justify-between gap-3 rounded-md border bg-[var(--bg-surface)] px-4 py-3"
					style={{ borderColor: 'var(--border-soft)' }}
				>
					<span className="font-mono text-xs" style={{ color: 'var(--fg-faint)' }}>
						{summariseRequirements(requirements, configuredSet, skippedSet, statuses.data ?? {})}
					</span>
					<Button
						onClick={onContinue}
						data-testid="connectors-inline-continue"
						disabled={!allHandled}
					>
						{allHandled ? 'Continue' : 'Configure or skip each connector'}
					</Button>
				</div>
			</div>
		</div>
	);
}

interface SubstepItemProps {
	index: number;
	requirement: ConnectorRequirement;
	status: ConnectorStatus | 'skipped';
}

function SubstepItem({ index, requirement, status }: SubstepItemProps) {
	const def = findConnector(requirement.connectorId);
	const done = status === 'configured' || status === 'skipped';
	return (
		<li
			className="flex items-center gap-3 rounded-md px-3 py-2 text-sm"
			data-testid={`connector-substep-${requirement.connectorId}`}
			data-status={status}
			style={{
				background: 'transparent',
				color: 'var(--fg-muted)',
			}}
		>
			<span
				className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-semibold"
				style={{
					background:
						status === 'configured'
							? 'var(--success, var(--primary))'
							: status === 'skipped'
								? 'var(--bg-raised)'
								: 'var(--bg-raised)',
					color:
						status === 'configured'
							? 'var(--primary-fg, white)'
							: status === 'skipped'
								? 'var(--fg-faint)'
								: 'var(--fg-faint)',
				}}
				aria-hidden="true"
			>
				{done ? (status === 'configured' ? '✓' : '–') : index}
			</span>
			<span style={{ color: done ? 'var(--fg-muted)' : 'var(--fg)' }}>
				{def?.display ?? requirement.connectorId}
			</span>
		</li>
	);
}

interface ConnectorSectionProps {
	connector: ConnectorDef;
	requirement: ConnectorRequirement;
	liveStatus: ConnectorStatus | undefined;
	isSkipped: boolean;
	isConfigured: boolean;
	onConfigured: () => void;
	onSkip: () => void;
}

function ConnectorSection({
	connector,
	requirement,
	liveStatus,
	isSkipped,
	isConfigured,
	onConfigured,
	onSkip,
}: ConnectorSectionProps) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);

	const status: ConnectorStatus | 'skipped' = isSkipped
		? 'skipped'
		: isConfigured
			? 'configured'
			: (liveStatus ?? 'not_configured');

	const missing = connector.fields
		.filter((f) => f.required)
		.filter((f) => !(values[f.id] ?? '').trim());

	const handleSave = async () => {
		setBusy(true);
		setSaveError(null);
		try {
			await connector.write(values);
			onConfigured();
		} catch (e) {
			setSaveError((e as Error).message ?? 'Save failed.');
		} finally {
			setBusy(false);
		}
	};

	const handleTest = async () => {
		if (!connector.test) return;
		setBusy(true);
		try {
			setTestResult(await connector.test(values));
		} catch (e) {
			setTestResult({ ok: false, message: (e as Error).message ?? 'Test failed.' });
		} finally {
			setBusy(false);
		}
	};

	const requiredByNames = requirement.requiredBy
		.map((id) => findCatalogEntry(id)?.display ?? id)
		.sort();

	return (
		<section
			className="rounded-lg border p-6"
			style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
			data-testid={`connector-section-${connector.id}`}
			data-status={status}
		>
			<header className="mb-4 flex items-start justify-between gap-4">
				<div>
					<p
						className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
						style={{ color: 'var(--primary)' }}
					>
						Connector · {connector.display}
					</p>
					<h2 className="text-xl font-bold leading-tight tracking-tight">
						Configure {connector.display}.
					</h2>
					<p
						className="mt-2 max-w-[60ch] text-sm leading-relaxed"
						style={{ color: 'var(--fg-muted)' }}
					>
						{connector.tagline}
					</p>
				</div>
				<StatusBadge status={status} />
			</header>

			<div className="space-y-4">
				{connector.fields.map((field) => (
					<div key={field.id} className="space-y-1.5">
						<label
							className="block text-xs font-medium"
							style={{ color: 'var(--fg-muted)' }}
							htmlFor={`${connector.id}-${field.id}`}
						>
							{field.label}
							{!field.required && (
								<span className="ml-1.5 font-normal" style={{ color: 'var(--fg-faint)' }}>
									— optional
								</span>
							)}
						</label>
						<Input
							id={`${connector.id}-${field.id}`}
							type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
							value={values[field.id] ?? ''}
							onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
							placeholder={field.placeholder}
							className="h-9 font-mono text-xs"
							disabled={busy}
							data-testid={`connector-field-${connector.id}-${field.id}`}
						/>
						{field.hint && (
							<div className="text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
								{field.hint}
							</div>
						)}
					</div>
				))}
			</div>

			<div
				className="mt-5 flex flex-wrap items-center gap-2 text-xs"
				style={{ color: 'var(--fg-muted)' }}
			>
				<strong style={{ color: 'var(--fg)' }}>Needed by:</strong>
				{requiredByNames.map((n) => (
					<span
						key={n}
						className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
						style={{ background: 'var(--bg-raised)', color: 'var(--fg-muted)' }}
					>
						{n}
					</span>
				))}
			</div>

			{testResult && (
				<div
					className="mt-5 flex items-center gap-3 rounded-md border p-3"
					style={{
						borderColor: 'var(--border-soft)',
						background: testResult.ok ? 'var(--success-soft, var(--bg-base))' : 'var(--bg-sunken)',
					}}
					data-testid={`connector-test-result-${connector.id}`}
				>
					<span
						className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
						style={{
							background: testResult.ok
								? 'var(--success, var(--primary))'
								: 'var(--warning, var(--fg-muted))',
							color: 'var(--primary-fg, white)',
						}}
						aria-hidden="true"
					>
						{testResult.ok ? '✓' : '!'}
					</span>
					<div className="flex-1 text-sm">
						<div className="font-semibold">
							{testResult.ok ? 'Connection verified' : 'Connection failed'}
						</div>
						{testResult.message && (
							<div className="mt-0.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
								{testResult.message}
							</div>
						)}
					</div>
				</div>
			)}

			{saveError && (
				<div
					className="mt-5 rounded-md border p-3 text-xs"
					style={{
						borderColor: 'var(--danger, var(--border-strong))',
						background: 'var(--danger-soft, var(--bg-sunken))',
					}}
					data-testid={`connector-save-error-${connector.id}`}
				>
					{saveError}
				</div>
			)}

			<footer className="mt-6 flex flex-wrap items-center justify-end gap-2">
				{connector.test && (
					<Button
						variant="ghost"
						size="sm"
						onClick={handleTest}
						disabled={busy || missing.length > 0}
						data-testid={`connector-test-${connector.id}`}
					>
						Test connection
					</Button>
				)}
				<Button
					variant="secondary"
					size="sm"
					onClick={onSkip}
					disabled={busy}
					data-testid={`connector-skip-${connector.id}`}
				>
					Skip {connector.display}
				</Button>
				<Button
					size="sm"
					onClick={handleSave}
					disabled={busy || missing.length > 0}
					data-testid={`connector-save-${connector.id}`}
				>
					{busy ? 'Saving…' : isConfigured ? 'Saved · update' : 'Save'}
				</Button>
			</footer>
		</section>
	);
}

function StatusBadge({ status }: { status: ConnectorStatus | 'skipped' }) {
	const palette: Record<ConnectorStatus | 'skipped', { bg: string; fg: string; label: string }> = {
		configured: {
			bg: 'var(--success-soft, var(--bg-raised))',
			fg: 'var(--success, var(--fg))',
			label: 'configured',
		},
		partial: {
			bg: 'var(--warning-soft, var(--bg-raised))',
			fg: 'var(--warning, var(--fg))',
			label: 'partial',
		},
		invalid: {
			bg: 'var(--danger-soft, var(--bg-raised))',
			fg: 'var(--danger, var(--fg))',
			label: 'invalid',
		},
		not_configured: {
			bg: 'var(--bg-raised)',
			fg: 'var(--fg-faint)',
			label: 'not configured',
		},
		skipped: { bg: 'var(--bg-raised)', fg: 'var(--fg-faint)', label: 'skipped' },
	};
	const c = palette[status];
	return (
		<span
			className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
			style={{ background: c.bg, color: c.fg }}
			data-testid="connector-status-badge"
		>
			<span className="h-1.5 w-1.5 rounded-full" style={{ background: c.fg }} aria-hidden="true" />
			{c.label}
		</span>
	);
}

// ── Pure helpers — exported for tests ─────────────────────────────────────

/**
 * Surface line for the connector step's sticky footer. Counts how many
 * connectors are configured, skipped, or still pending.
 */
export function summariseRequirements(
	requirements: readonly ConnectorRequirement[],
	configured: ReadonlySet<ConnectorId>,
	skipped: ReadonlySet<ConnectorId>,
	live: Partial<Record<ConnectorId, ConnectorStatus>>
): string {
	let done = 0;
	let skip = 0;
	for (const r of requirements) {
		if (configured.has(r.connectorId)) done++;
		else if (skipped.has(r.connectorId)) skip++;
		else if (live[r.connectorId] === 'configured') done++;
	}
	const pending = requirements.length - done - skip;
	const parts = [`${done}/${requirements.length} configured`];
	if (skip > 0) parts.push(`${skip} skipped`);
	if (pending > 0) parts.push(`${pending} pending`);
	return parts.join(' · ');
}

/**
 * For a given pkg selection, decide whether the connector step is
 * "auto-skippable" — i.e. there are no connectors to configure.
 */
export function isAutoSkippable(selectedPkgIds: readonly string[]): boolean {
	return (
		resolveRequiredConnectors(
			selectedPkgIds,
			ONBOARDING_PKG_CATALOG.map((p) => p.manifest)
		).length === 0
	);
}

/**
 * Returns true when the user has either configured or skipped every
 * surfaced connector — i.e. the Continue button should enable.
 */
export function isReadyToContinue(
	requirements: readonly ConnectorRequirement[],
	configured: ReadonlySet<ConnectorId>,
	skipped: ReadonlySet<ConnectorId>,
	live: Partial<Record<ConnectorId, ConnectorStatus>>
): boolean {
	if (requirements.length === 0) return true;
	return requirements.every(
		(r) =>
			configured.has(r.connectorId) ||
			skipped.has(r.connectorId) ||
			live[r.connectorId] === 'configured'
	);
}

// Re-export so test imports stay tidy.
export { CONNECTOR_REGISTRY };
