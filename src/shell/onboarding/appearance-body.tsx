// Step 7 — Appearance (theme · mode · density).
//
// Wires the existing ikenga theme store. Selection mutates the store
// immediately so the chrome reflects the change live — that store is
// already subscribed to `<html>` data-attribute writes via
// `installIkengaDomSync()` at boot, so we don't have to touch the DOM
// here.
//
// Mirrors the Phase 1 prototype `07-appearance.html` (theme grid +
// mode row + density grid).

import { useEffect } from 'react';

import { cn } from '@/components/ui/utils';
import { Button } from '@/components/ui/button';
import {
	type IkengaDensity,
	type IkengaMode,
	type IkengaTheme,
	useIkengaStore,
} from '@/lib/ikenga/theme-store';

import { useOnboardingStep } from './use-onboarding-step';

export interface AppearancePayload {
	theme: IkengaTheme;
	mode: IkengaMode;
	density: IkengaDensity;
}

interface AppearanceBodyProps {
	onContinue: () => void;
}

const THEMES: Array<{ id: IkengaTheme; name: string; description: string; swatches: string[] }> = [
	{
		id: 'A',
		name: 'Dusk Wood',
		description: 'Warm cream + oxblood-clay. The canonical Ikenga look.',
		swatches: ['hsl(36,22%,96%)', 'hsl(20,50%,34%)', 'hsl(170,36%,32%)'],
	},
	{
		id: 'B',
		name: 'Kola Daylight',
		description: 'Brighter cream with amber/terracotta accents.',
		swatches: ['hsl(36,28%,96%)', 'hsl(42,82%,46%)', 'hsl(14,72%,46%)'],
	},
	{
		id: 'C',
		name: 'Bronze Shrine',
		description: 'Cool verdigris with bronze accent. Quiet, focused.',
		swatches: ['hsl(180,10%,95%)', 'hsl(170,42%,34%)', 'hsl(40,64%,38%)'],
	},
];

const DENSITIES: Array<{ id: IkengaDensity; label: string; meta: string }> = [
	{ id: 'compact', label: 'Compact', meta: 'More information per screen. Best for power users.' },
	{
		id: 'comfortable',
		label: 'Comfortable',
		meta: 'Balanced spacing. Recommended for most.',
	},
	{ id: 'spacious', label: 'Spacious', meta: 'Generous padding. Good on larger displays.' },
];

export function AppearanceBody({ onContinue }: AppearanceBodyProps) {
	const theme = useIkengaStore((s) => s.theme);
	const mode = useIkengaStore((s) => s.mode);
	const density = useIkengaStore((s) => s.density);
	const setTheme = useIkengaStore((s) => s.setTheme);
	const setMode = useIkengaStore((s) => s.setMode);
	const setDensity = useIkengaStore((s) => s.setDensity);

	const { setPayload } = useOnboardingStep<AppearancePayload>('appearance');

	useEffect(() => {
		setPayload({ theme, mode, density });
	}, [theme, mode, density, setPayload]);

	return (
		<div className="mx-auto max-w-4xl">
			<div className="mb-8">
				<p
					className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
					style={{ color: 'var(--primary)' }}
				>
					Make it yours
				</p>
				<h1 className="text-3xl font-bold leading-tight tracking-tight">
					Pick a workspace palette &amp; density.
				</h1>
				<p className="mt-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
					Changes apply live. You can keep tweaking from{' '}
					<span className="font-mono text-xs">Settings → Appearance</span>.
				</p>
			</div>

			{/* ── Theme grid ───────────────────────────────────────────────── */}
			<section className="mb-8">
				<div
					className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.05em]"
					style={{ color: 'var(--fg-faint)' }}
				>
					Theme
				</div>
				<div className="grid gap-4 sm:grid-cols-3" data-testid="theme-grid">
					{THEMES.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setTheme(t.id)}
							className={cn(
								'relative overflow-hidden rounded-lg border text-left transition-colors'
							)}
							style={{
								borderColor: theme === t.id ? 'var(--primary)' : 'var(--border-soft)',
								background: 'var(--bg-surface)',
								boxShadow: theme === t.id ? '0 0 0 1px var(--primary)' : undefined,
							}}
							data-testid="theme-card"
							data-theme-id={t.id}
							data-selected={theme === t.id}
						>
							{theme === t.id && (
								<span
									className="absolute right-2.5 top-2.5 flex h-4.5 w-4.5 items-center justify-center rounded-full text-[10px] font-bold"
									style={{
										background: 'var(--primary)',
										color: 'var(--primary-fg, white)',
										height: '18px',
										width: '18px',
									}}
									aria-hidden="true"
								>
									✓
								</span>
							)}
							<div
								className="flex h-24 flex-col justify-between gap-2 p-3"
								style={{ background: t.swatches[0] }}
							>
								<div className="h-1.5 w-[60%] rounded-full" style={{ background: t.swatches[1] }} />
								<div className="flex items-center gap-1">
									<span className="h-3 w-6 rounded-sm" style={{ background: t.swatches[1] }} />
									<span
										className="h-3 flex-1 rounded-sm"
										style={{ background: 'rgba(0,0,0,0.06)' }}
									/>
								</div>
								<div className="flex items-center gap-1">
									<span className="h-3 w-8 rounded-sm" style={{ background: t.swatches[2] }} />
									<span
										className="h-3 flex-1 rounded-sm"
										style={{ background: 'rgba(0,0,0,0.06)' }}
									/>
								</div>
							</div>
							<div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-soft)' }}>
								<div className="text-[13.5px] font-bold">
									{t.name}
									{t.id === 'A' && (
										<span
											className="ml-2 text-[10.5px] font-normal"
											style={{ color: 'var(--fg-faint)' }}
										>
											default
										</span>
									)}
								</div>
								<div className="mt-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
									{t.description}
								</div>
							</div>
						</button>
					))}
				</div>
			</section>

			{/* ── Mode toggle ──────────────────────────────────────────────── */}
			<section className="mb-8">
				<div
					className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.05em]"
					style={{ color: 'var(--fg-faint)' }}
				>
					Mode
				</div>
				<div
					className="inline-flex gap-2 rounded-md border p-1"
					style={{
						borderColor: 'var(--border-soft)',
						background: 'var(--bg-surface)',
					}}
					data-testid="mode-row"
				>
					<ModeButton on={mode === 'light'} onClick={() => setMode('light')} label="Light" />
					<ModeButton on={mode === 'dark'} onClick={() => setMode('dark')} label="Dark" />
					<ModeButton on={mode === 'system'} onClick={() => setMode('system')} label="System" />
				</div>
				{mode === 'system' && (
					<p className="mt-2 text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
						Following the OS preference (<span className="font-mono">prefers-color-scheme</span>) —
						flips automatically when you toggle night mode.
					</p>
				)}
			</section>

			{/* ── Density grid ─────────────────────────────────────────────── */}
			<section className="mb-8">
				<div
					className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.05em]"
					style={{ color: 'var(--fg-faint)' }}
				>
					Density
				</div>
				<div className="grid gap-3 sm:grid-cols-3" data-testid="density-grid">
					{DENSITIES.map((d) => (
						<button
							key={d.id}
							type="button"
							onClick={() => setDensity(d.id)}
							className="flex items-center gap-3 rounded-md border p-4 text-left transition-colors"
							style={{
								borderColor: density === d.id ? 'var(--primary)' : 'var(--border-soft)',
								background: 'var(--bg-surface)',
								boxShadow: density === d.id ? '0 0 0 1px var(--primary)' : undefined,
							}}
							data-testid="density-card"
							data-density-id={d.id}
							data-selected={density === d.id}
						>
							<DensityGlyph id={d.id} />
							<div>
								<div className="text-[13px] font-semibold">
									{d.label}
									{d.id === 'comfortable' && (
										<span
											className="ml-2 text-[10.5px] font-normal"
											style={{ color: 'var(--fg-faint)' }}
										>
											default
										</span>
									)}
								</div>
								<div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
									{d.meta}
								</div>
							</div>
						</button>
					))}
				</div>
			</section>

			<div className="mt-8 flex items-center justify-end gap-3">
				<Button onClick={onContinue} data-testid="appearance-inline-continue">
					Continue
				</Button>
			</div>
		</div>
	);
}

function ModeButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn('inline-flex h-8 items-center gap-1.5 rounded-sm px-4 text-xs font-medium')}
			style={{
				background: on ? 'var(--bg-base)' : 'transparent',
				color: on ? 'var(--fg)' : 'var(--fg-muted)',
				boxShadow: on ? 'var(--shadow-1, 0 1px 2px rgba(0,0,0,0.05))' : 'none',
			}}
			data-mode-id={label.toLowerCase()}
			data-selected={on}
		>
			{label}
		</button>
	);
}

function DensityGlyph({ id }: { id: IkengaDensity }) {
	const lines = id === 'compact' ? 5 : id === 'comfortable' ? 4 : 3;
	const lineHeight = id === 'spacious' ? 3 : id === 'compact' ? 1.5 : 2;
	return (
		<div className="flex h-10 w-9 flex-none flex-col justify-around" aria-hidden="true">
			{Array.from({ length: lines }, (_, i) => `density-line-${id}-${i}`).map((key) => (
				<span
					key={key}
					className="block rounded-sm"
					style={{
						height: `${lineHeight}px`,
						background: 'var(--fg-muted)',
					}}
				/>
			))}
		</div>
	);
}
