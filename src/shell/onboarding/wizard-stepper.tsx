// <WizardStepper> — Variant A (edge-to-edge full-window) chrome.
//
// The Phase 1 approved design (`<workspace>/design/shell/concepts/03-screens/
// 2026-05-11-onboarding-wizard/prototypes/variant-A-welcome.html`) maps to
// this layout:
//   ┌──────────────────────────────────────────────┐  <- title bar (Tauri)
//   │▰▰▰▱▱▱▱▱▱  progress fill (doubles as stepper) │  4px tall
//   │  brand ─────────────── step N of 9 · Welcome │  header
//   ├──────────────────────────────────────────────┤
//   │              <step body content>             │  scrollable
//   ├──────────────────────────────────────────────┤
//   │ meta              [Skip]  [Back]  [Continue] │  footer
//   └──────────────────────────────────────────────┘
//
// Step bodies are render-prop children. They receive `{ goNext, goBack,
// skip, payload, setPayload, record }` — but step bodies are STUBS in
// Phase 3 (Phase 4 fills them).

import { useEffect, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';

import {
	ONBOARDING_STEPS,
	type OnboardingStepId,
	type OnboardingStepRecord,
	useShellStore,
} from '@/lib/shell/shell-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';

import { useOnboardingStep } from './use-onboarding-step';

// Human-readable labels for the stepper header. Kept here rather than on
// the step type itself so the wizard chrome owns the copy. Tier-1 lore
// terms (Chi, Obi) replace the technical English in the breadcrumb per
// design/shell/concepts/03-screens/onboarding-wizard/specs/PHASE-1B-LORE-DELTA.md.
const STEP_LABELS: Record<OnboardingStepId, string> = {
	welcome: 'Consecration',
	agent: 'Chi',
	roots: 'Obi',
	packages: 'Alusi',
	connectors: 'Connectors',
	scaffolding: 'Scaffolding',
	appearance: 'Appearance',
	telemetry: 'Telemetry',
	summary: 'Summary',
};

export interface WizardStepChildArgs<P> {
	goNext: () => void;
	goBack: () => void;
	skip: () => void;
	/** Jump to an arbitrary step. Sets `mode: 'edit'` if not already. */
	goTo: (id: OnboardingStepId) => void;
	payload: P | undefined;
	setPayload: (p: P) => void;
	record: OnboardingStepRecord<P>;
	isOptional: boolean;
	isFirst: boolean;
	isLast: boolean;
}

interface WizardStepperProps<P> {
	stepId: OnboardingStepId;
	children: (args: WizardStepChildArgs<P>) => React.ReactNode;
}

export function WizardStepper<P = unknown>({ stepId, children }: WizardStepperProps<P>) {
	const navigate = useNavigate();
	const { record, setPayload, markCompleted, markSkipped, isOptional } =
		useOnboardingStep<P>(stepId);

	const activeIndex = useShellStore((s) => s.onboarding.activeIndex);
	const mode = useShellStore((s) => s.onboarding.mode);
	const steps = useShellStore((s) => s.onboarding.steps);
	const startOnboarding = useShellStore((s) => s.startOnboarding);
	const setActiveIndex = useShellStore((s) => s.setOnboardingActiveIndex);
	const enterOnboardingEdit = useShellStore((s) => s.enterOnboardingEdit);
	const finishOnboarding = useShellStore((s) => s.finishOnboarding);

	const myIndex = ONBOARDING_STEPS.indexOf(stepId);
	const isFirst = myIndex === 0;
	const isLast = myIndex === ONBOARDING_STEPS.length - 1;
	const progressPct = ((myIndex + 1) / ONBOARDING_STEPS.length) * 100;

	// On mount of each step, ensure the store's activeIndex matches the URL
	// (the user may have navigated via the address bar / settings link).
	// Idempotent — guarded against re-entry by the equality check.
	useEffect(() => {
		if (myIndex >= 0 && myIndex !== activeIndex) {
			setActiveIndex(myIndex);
		}
		// Lazily stamp `startedAt` the first time any step renders. The store
		// action is idempotent so this is safe on every effect run.
		startOnboarding(mode);
	}, [myIndex, activeIndex, setActiveIndex, startOnboarding, mode]);

	const goNext = useMemo(
		() => () => {
			// Mark this step complete, then walk to the next. The summary step's
			// "Open workspace" handler stamps `completedAt` separately (Phase 4
			// wires that — Phase 3's summary stub doesn't trigger it).
			markCompleted();
			const nextIndex = Math.min(ONBOARDING_STEPS.length - 1, myIndex + 1);
			const nextId = ONBOARDING_STEPS[nextIndex]!;
			setActiveIndex(nextIndex);
			if (isLast) {
				// Finishing the summary step itself just stays put; the explicit
				// "Open workspace" action is the real exit.
				return;
			}
			void navigate({ to: `/onboarding/${nextId}` });
		},
		[isLast, markCompleted, myIndex, navigate, setActiveIndex]
	);

	const goBack = useMemo(
		() => () => {
			if (isFirst) return;
			const prevIndex = Math.max(0, myIndex - 1);
			const prevId = ONBOARDING_STEPS[prevIndex]!;
			setActiveIndex(prevIndex);
			void navigate({ to: `/onboarding/${prevId}` });
		},
		[isFirst, myIndex, navigate, setActiveIndex]
	);

	const skip = useMemo(
		() => () => {
			if (!isOptional) return;
			markSkipped();
			const nextIndex = Math.min(ONBOARDING_STEPS.length - 1, myIndex + 1);
			const nextId = ONBOARDING_STEPS[nextIndex]!;
			setActiveIndex(nextIndex);
			void navigate({ to: `/onboarding/${nextId}` });
		},
		[isOptional, markSkipped, myIndex, navigate, setActiveIndex]
	);

	const goTo = useMemo(
		() => (id: OnboardingStepId) => {
			enterOnboardingEdit(id);
			void navigate({ to: `/onboarding/${id}` });
		},
		[enterOnboardingEdit, navigate]
	);

	// Phase 3 doesn't auto-finish — but expose the handle on the last step
	// so Phase 4's summary body can call it.
	const childArgs: WizardStepChildArgs<P> = {
		goNext: isLast ? finishOnboarding : goNext,
		goBack,
		skip,
		goTo,
		payload: record.payload,
		setPayload,
		record,
		isOptional,
		isFirst,
		isLast,
	};

	return (
		<div
			data-testid="wizard-stepper"
			className="flex h-full min-h-0 flex-col bg-background text-foreground"
		>
			{/* ── Progress rail — doubles as stepper (Variant A) ───────── */}
			<div
				className="h-1 w-full"
				style={{ background: 'var(--bg-raised)' }}
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={ONBOARDING_STEPS.length}
				aria-valuenow={myIndex + 1}
				aria-label={`Onboarding progress: step ${myIndex + 1} of ${ONBOARDING_STEPS.length}`}
			>
				<div
					data-testid="wizard-progress-fill"
					className="h-full transition-[width] duration-300 ease-out"
					style={{ width: `${progressPct}%`, background: 'var(--primary)' }}
				/>
			</div>

			{/* ── Header — brand + step label ────────────────────────── */}
			<header
				className="flex items-center justify-between border-b px-12 py-5"
				style={{ borderColor: 'var(--border-soft)' }}
			>
				<div className="inline-flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M4 20L12 4L20 20"
							stroke="var(--primary)"
							strokeWidth="2.4"
							strokeLinecap="square"
						/>
						<path d="M8 14H16" stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="square" />
					</svg>
					Ikenga
				</div>
				<div
					data-testid="wizard-step-label"
					className="text-xs"
					style={{ color: 'var(--fg-muted)' }}
				>
					Step{' '}
					<span className="font-semibold" style={{ color: 'var(--fg)' }}>
						{myIndex + 1}
					</span>{' '}
					of {ONBOARDING_STEPS.length} · {STEP_LABELS[stepId]}
					{mode === 'edit' && (
						<span
							className="ml-3 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
							style={{
								background: 'var(--info-soft)',
								color: 'var(--info)',
							}}
						>
							Edit
						</span>
					)}
				</div>
			</header>

			{/* ── Body — step bodies render here. ────────────────────── */}
			<div className="min-h-0 flex-1 overflow-auto px-16 py-10">{children(childArgs)}</div>

			{/* ── Footer — Skip / Back / Continue ─────────────────────── */}
			<footer
				className="flex items-center justify-between border-t px-12 py-4"
				style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
			>
				<span className="font-mono text-xs" style={{ color: 'var(--fg-faint)' }}>
					{summariseProgress(steps)}
				</span>
				<div className="flex items-center gap-3">
					{isOptional && !isLast && (
						<Button variant="ghost" onClick={skip} data-testid="wizard-skip" className={cn('h-9')}>
							Skip
						</Button>
					)}
					{!isFirst && (
						<Button
							variant="ghost"
							onClick={goBack}
							data-testid="wizard-back"
							className={cn('h-9')}
						>
							Back
						</Button>
					)}
					<Button
						onClick={childArgs.goNext}
						data-testid="wizard-next"
						className="h-11 px-6 text-sm font-semibold"
					>
						{isLast ? 'Enter your Obi' : 'Continue'}
					</Button>
				</div>
			</footer>
		</div>
	);
}

function summariseProgress(steps: Record<OnboardingStepId, OnboardingStepRecord>): string {
	let done = 0;
	let skipped = 0;
	for (const id of ONBOARDING_STEPS) {
		const r = steps[id];
		if (r.status === 'completed') done++;
		if (r.status === 'skipped') skipped++;
	}
	const parts = [`${done}/${ONBOARDING_STEPS.length} done`];
	if (skipped > 0) parts.push(`${skipped} skipped`);
	return parts.join(' · ');
}
