// Settings → Integrations connector cards.
//
// Driven by the same onboarding resolver as the wizard's step 5: walks
// every installed pkg, derives which connectors are required, and
// renders a card per connector that isn't already configured.
// Each card body is the same input set the wizard collected.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusChip, type ChipTone } from '@/components/ui/status-chip';
import { cn } from '@/components/ui/utils';
import {
	type ConnectorDef,
	type ConnectorField,
	type ConnectorId,
	type ConnectorStatus,
	type ConnectorTestResult,
	findConnector,
} from '@/lib/onboarding/connectors';
import { resolveRequiredConnectors } from '@/lib/onboarding/resolve-connectors';
import { useInstalledManifests } from '@/lib/onboarding/use-installed-manifests';

const STATUS_QUERY_KEY = ['settings', 'connector-card-status'] as const;

/**
 * Section that lists every connector required by an installed pkg.
 * Renders the same form the wizard collected during onboarding. Empty when
 * either (a) no connector-requiring pkgs are installed, or (b) every
 * required connector is already configured.
 */
export function ConnectorCardsSection() {
	const installed = useInstalledManifests();
	const queryClient = useQueryClient();

	const installedManifests = installed.data ?? [];
	const installedIds = useMemo(() => installedManifests.map((p) => p.pkgId), [installedManifests]);

	const requirements = useMemo(
		() =>
			resolveRequiredConnectors(
				installedIds,
				installedManifests.map((p) => p.manifest)
			),
		[installedIds, installedManifests]
	);

	const statuses = useQuery({
		queryKey: [...STATUS_QUERY_KEY, requirements.map((r) => r.connectorId).join(',')],
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
		staleTime: 30_000,
		refetchOnWindowFocus: false,
		enabled: requirements.length > 0,
	});

	if (installed.isLoading) return null;
	if (requirements.length === 0) return null;

	const missing = requirements.filter(
		(r) => (statuses.data?.[r.connectorId] ?? 'not_configured') !== 'configured'
	);
	if (missing.length === 0) return null;

	return (
		<section
			className="rounded-md border"
			style={{ borderColor: 'var(--border-soft)' }}
			data-testid="connector-cards-section"
		>
			<header className="border-b px-4 py-2.5" style={{ borderColor: 'var(--border-soft)' }}>
				<div className="text-[13px] font-semibold">Connectors required by installed packages</div>
				<div className="mt-0.5 text-xs text-muted-foreground">
					Pkgs you've installed declare these connectors. Configure them to enable the corresponding
					features.
				</div>
			</header>
			<div className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
				{missing.map((req) => {
					const def = findConnector(req.connectorId);
					if (!def) return null;
					const status = statuses.data?.[req.connectorId] ?? 'not_configured';
					return (
						<ConnectorCard
							key={req.connectorId}
							connector={def}
							requiredBy={req.requiredBy}
							status={status}
							onSaved={() => {
								void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
							}}
						/>
					);
				})}
			</div>
		</section>
	);
}

interface ConnectorCardProps {
	connector: ConnectorDef;
	requiredBy: readonly string[];
	status: ConnectorStatus;
	onSaved: () => void;
}

function ConnectorCard({ connector, requiredBy, status, onSaved }: ConnectorCardProps) {
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);

	const missingRequired = connector.fields
		.filter((f) => f.required)
		.filter((f) => !(values[f.id] ?? '').trim());

	const handleSave = async () => {
		setBusy(true);
		setSaveError(null);
		try {
			await connector.write(values);
			onSaved();
			setOpen(false);
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

	const formId = `connector-form-${connector.id}`;

	return (
		<div className="px-4 py-3" data-testid={`connector-card-${connector.id}`} data-status={status}>
			<div className="flex items-center justify-between gap-3">
				<div>
					<div className="text-[13px] font-semibold">{connector.display}</div>
					<div className="mt-0.5 text-xs text-muted-foreground">
						Required by: {requiredBy.join(', ') || '(no consumers)'}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<StatusPill status={status} />
					<Button
						size="sm"
						variant={open ? 'ghost' : 'default'}
						onClick={() => setOpen((v) => !v)}
						aria-expanded={open}
						aria-controls={formId}
						data-testid={`connector-card-toggle-${connector.id}`}
					>
						{open ? 'Hide' : status === 'configured' ? 'Edit' : 'Configure'}
					</Button>
				</div>
			</div>
			{open && (
				<div
					id={formId}
					className="mt-3 space-y-3 rounded-md border bg-[var(--bg-base)] p-3"
					style={{ borderColor: 'var(--border-soft)' }}
				>
					<p className="text-xs text-muted-foreground">{connector.tagline}</p>
					{connector.fields.map((field) => (
						<FieldRow
							key={field.id}
							field={field}
							value={values[field.id] ?? ''}
							onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
							disabled={busy}
							testIdPrefix={`connector-card-field-${connector.id}`}
						/>
					))}
					{testResult && (
						<div
							role={testResult.ok ? 'status' : 'alert'}
							className={cn(
								'rounded border px-3 py-2 text-xs',
								testResult.ok
									? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
									: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
							)}
							data-testid={`connector-card-test-${connector.id}`}
						>
							{testResult.ok ? '✓ Connection verified' : '! Connection failed'}
							{testResult.message && <span className="ml-2 opacity-80">{testResult.message}</span>}
						</div>
					)}
					{saveError && (
						<div
							role="alert"
							className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
							data-testid={`connector-card-error-${connector.id}`}
						>
							{saveError}
						</div>
					)}
					<div className="flex items-center justify-end gap-2">
						{connector.test && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => void handleTest()}
								disabled={busy || missingRequired.length > 0}
								data-testid={`connector-card-test-btn-${connector.id}`}
							>
								Test connection
							</Button>
						)}
						<Button
							size="sm"
							onClick={() => void handleSave()}
							disabled={busy || missingRequired.length > 0}
							data-testid={`connector-card-save-${connector.id}`}
						>
							{busy ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

interface FieldRowProps {
	field: ConnectorField;
	value: string;
	onChange: (v: string) => void;
	disabled?: boolean;
	testIdPrefix: string;
}

function FieldRow({ field, value, onChange, disabled, testIdPrefix }: FieldRowProps) {
	return (
		<div className="space-y-1">
			<label
				className="block text-[11px] font-medium text-muted-foreground"
				htmlFor={`${testIdPrefix}-${field.id}`}
			>
				{field.label}
				{!field.required && (
					<span className="ml-1.5 font-normal text-[var(--fg-faint)]">— optional</span>
				)}
			</label>
			<Input
				id={`${testIdPrefix}-${field.id}`}
				type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={field.placeholder}
				disabled={disabled}
				className="h-8 font-mono text-xs"
				data-testid={`${testIdPrefix}-${field.id}`}
			/>
			{field.hint && <div className="text-[10.5px] text-[var(--fg-faint)]">{field.hint}</div>}
		</div>
	);
}

function StatusPill({ status }: { status: ConnectorStatus }) {
	const toneMap: Record<ConnectorStatus, ChipTone> = {
		configured: 'live',
		partial: 'warn',
		invalid: 'danger',
		not_configured: 'muted',
	};
	const labelMap: Record<ConnectorStatus, string> = {
		configured: 'configured',
		partial: 'partial',
		invalid: 'invalid',
		not_configured: 'not configured',
	};
	return (
		<StatusChip tone={toneMap[status]} dot>
			{labelMap[status]}
		</StatusChip>
	);
}
