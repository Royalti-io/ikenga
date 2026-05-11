// Step 8 — Telemetry consent.
//
// Single toggle. Default OFF per APPROVAL.md + the "no dark patterns"
// rule. The toggle writes through to the step's payload (which is
// initialised to `DEFAULT_TELEMETRY_PAYLOAD = { enabled: false }` by
// the Phase 3 store).
//
// No remote send wiring lives here — Phase 9 picks that up once we
// settle on the telemetry collector. The wizard only persists the
// consent choice.

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { DEFAULT_TELEMETRY_PAYLOAD } from '@/lib/shell/shell-store';

import { useOnboardingStep } from './use-onboarding-step';

export interface TelemetryPayload {
	enabled: boolean;
}

interface TelemetryBodyProps {
	onContinue: () => void;
}

export function TelemetryBody({ onContinue }: TelemetryBodyProps) {
	const { record, setPayload } = useOnboardingStep<TelemetryPayload>('telemetry');

	// Default to OFF if nothing has been recorded yet — privacy-first,
	// matches APPROVAL.md.
	const current = record.payload?.enabled ?? DEFAULT_TELEMETRY_PAYLOAD.enabled;

	useEffect(() => {
		if (!record.payload) {
			setPayload({ enabled: false });
		}
	}, [record.payload, setPayload]);

	const toggle = () => setPayload({ enabled: !current });

	return (
		<div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-[1fr_320px]">
			<section>
				<p
					className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
					style={{ color: 'var(--primary)' }}
				>
					Privacy
				</p>
				<h1 className="text-3xl font-bold leading-tight tracking-tight">
					Help us make Ikenga better?
				</h1>
				<p className="mt-3 max-w-[60ch] text-sm" style={{ color: 'var(--fg-muted)' }}>
					A single switch. We collect anonymous numbers about what's installed and how the shell
					crashes — nothing about your files, prompts, agent conversations, or who you talk to.
				</p>

				<div
					className="mt-6 overflow-hidden rounded-lg border"
					style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
				>
					<div className="flex items-center justify-between gap-6 p-5">
						<div className="min-w-0">
							<div className="text-[14px] font-semibold">
								Share anonymous detection &amp; crash stats
							</div>
							<div
								className="mt-1 truncate text-[11.5px]"
								style={{ color: 'var(--fg-muted)' }}
							>
								Sent to <span className="font-mono">telemetry.ikenga.ai</span> · scrubbed at
								edge · 30-day retention
							</div>
						</div>
						<Toggle on={current} onClick={toggle} />
					</div>
					<div
						className="border-t px-5 py-4 text-xs"
						style={{ borderColor: 'var(--border-soft)', color: 'var(--fg-muted)' }}
					>
						You can flip this any time from{' '}
						<span className="font-mono text-[11px]">Settings → Privacy</span>. Crashes are
						logged locally to{' '}
						<span className="font-mono text-[11px]">~/.ikenga/crash/</span> either way, for your
						own debugging.
					</div>
				</div>

				<p className="mt-4 text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
					Default: OFF. We never opt anyone in by default.
				</p>

				<div className="mt-8 flex items-center justify-end gap-3">
					<Button onClick={onContinue} data-testid="telemetry-inline-continue">
						Continue
					</Button>
				</div>
			</section>

			<aside>
				<p
					className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.05em]"
					style={{ color: 'var(--fg-faint)' }}
				>
					What we do &amp; don't send
				</p>
				<div className="grid gap-4">
					<DataColumn
						title="We send"
						tone="send"
						items={[
							'Installed pkg names + versions',
							'OS + arch + Tauri version',
							'Shell crash stack traces (no user data)',
							'Anonymous install ID (regenerable)',
							'Active engine adapter (e.g. claude-code)',
							'Aggregated feature reach',
						]}
					/>
					<DataColumn
						title="We never send"
						tone="skip"
						items={[
							'File contents or names',
							'Agent prompts or responses',
							'Project paths or repo names',
							'Email, name, or account info',
							'Stronghold vault contents',
							'Anything from connected services',
						]}
					/>
				</div>
			</aside>
		</div>
	);
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			onClick={onClick}
			className={cn('relative h-6 w-11 flex-none rounded-full border transition-colors')}
			style={{
				background: on ? 'var(--primary)' : 'var(--bg-raised)',
				borderColor: on ? 'var(--primary)' : 'var(--border-soft)',
			}}
			data-testid="telemetry-toggle"
			data-on={on}
		>
			<span
				className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all"
				style={{
					left: on ? 'calc(100% - 20px)' : '4px',
					background: on ? 'var(--primary-fg, white)' : 'var(--fg-muted)',
				}}
				aria-hidden="true"
			/>
		</button>
	);
}

function DataColumn({
	title,
	tone,
	items,
}: {
	title: string;
	tone: 'send' | 'skip';
	items: string[];
}) {
	return (
		<div
			className="rounded-md border p-4"
			style={{
				borderColor: 'var(--border-soft)',
				background: 'var(--bg-surface)',
			}}
		>
			<div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
				<span
					className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
					style={{
						background:
							tone === 'send' ? 'var(--success)' : 'var(--bg-raised)',
						color: tone === 'send' ? 'var(--success-fg, white)' : 'var(--fg-faint)',
					}}
					aria-hidden="true"
				>
					{tone === 'send' ? '✓' : '—'}
				</span>
				{title}
			</div>
			<ul className="grid gap-1 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
				{items.map((it) => (
					<li key={it}>{it}</li>
				))}
			</ul>
		</div>
	);
}
