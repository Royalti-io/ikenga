import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Post-strip: only 4 first-class workspaces. Mail / Outbox / Studio /
// Agents were app-pkg surfaces and got removed with the strip-down.
// Mini-apps are gone too — they were placeholders for media tooling
// that lives in app pkgs now.
export type CoreMode = 'app' | 'files' | 'sessions' | 'settings';
export type ActivityMode = CoreMode;

// Default file roots match the Tauri capability allowlist in
// `src-tauri/capabilities/default.json`. Reads outside these paths fail
// regardless of what the user adds via Settings — we surface that warning
// in the editor.
export const DEFAULT_FILE_ROOTS: readonly string[] = Object.freeze([
	'~/royalti-co',
	'~/.company',
	'~/.claude/projects',
]);

// Project roots scanned by the /claude config browser. Each root is a dir
// that contains a `.claude/` subfolder (agents/skills/commands/settings).
// Personal `~/.claude/` is always scanned in addition to these — it doesn't
// need to be listed.
export const DEFAULT_CLAUDE_PROJECT_ROOTS: readonly string[] = Object.freeze(['~/royalti-co']);

// ─── Onboarding wizard state (Phase 3 scaffold) ──────────────────────────
//
// First-run setup. Persisted alongside the rest of shell-store so the user
// only sees the wizard once unless they explicitly re-run from Settings.
// Step bodies are filled in by Phase 4+; Phase 3 just lays down the shape +
// migration + chrome.

export type OnboardingStepId =
	| 'welcome'
	| 'agent'
	| 'roots'
	| 'packages'
	| 'connectors' // dynamic; substeps are derived (Phase 5)
	| 'scaffolding'
	| 'appearance'
	| 'telemetry'
	| 'summary';

export type OnboardingStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface OnboardingStepRecord<P = unknown> {
	status: OnboardingStatus;
	completedAt?: number;
	/** Step-local snapshot of what the user chose. Schema per step. */
	payload?: P;
}

export interface OnboardingState {
	/** Bump to re-prompt for new mandatory steps in a future release. */
	version: number;
	startedAt: number | null;
	completedAt: number | null;
	/** First-run vs. re-run from Settings. */
	mode: 'first_run' | 'edit';
	/** Index of the currently active step (within the ordered step list). */
	activeIndex: number;
	steps: Record<OnboardingStepId, OnboardingStepRecord>;
	selectedAgentId: string | null;
}

// Canonical step order. Source of truth for activeIndex math + stepper UI.
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = Object.freeze([
	'welcome',
	'agent',
	'roots',
	'packages',
	'connectors',
	'scaffolding',
	'appearance',
	'telemetry',
	'summary',
]);

// Steps the user is allowed to skip. Welcome/Summary are not skippable
// (they're framing), agent/roots/packages are required to actually use
// the shell. The rest are optional.
export const OPTIONAL_ONBOARDING_STEPS: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>([
	'connectors',
	'scaffolding',
	'appearance',
	'telemetry',
]);

/** Bump when the OnboardingState shape changes in a way that needs migration. */
export const ONBOARDING_STATE_VERSION = 1;

function freshStepRecord(): OnboardingStepRecord {
	return { status: 'pending' };
}

export function createDefaultOnboardingState(): OnboardingState {
	return {
		version: ONBOARDING_STATE_VERSION,
		startedAt: null,
		completedAt: null,
		mode: 'first_run',
		activeIndex: 0,
		steps: ONBOARDING_STEPS.reduce(
			(acc, id) => {
				acc[id] = freshStepRecord();
				return acc;
			},
			{} as Record<OnboardingStepId, OnboardingStepRecord>
		),
		selectedAgentId: null,
	};
}

// Telemetry default — locked to OFF per APPROVAL.md (privacy-first).
// Phase 4's telemetry step uses this as the initial payload until the user
// flips the toggle.
export const DEFAULT_TELEMETRY_PAYLOAD = Object.freeze({ enabled: false });

interface ShellState {
	activeMode: ActivityMode;
	setActiveMode: (m: ActivityMode) => void;

	fileRoots: string[];
	addFileRoot: (path: string) => void;
	removeFileRoot: (path: string) => void;
	/** Replace `oldPath` with `newPath` (no-op if oldPath isn't present, or if
	 * the new path is empty / a duplicate of an existing entry). Used by the
	 * editable settings selectors. */
	updateFileRoot: (oldPath: string, newPath: string) => void;
	resetFileRoots: () => void;

	claudeProjectRoots: string[];
	addClaudeProjectRoot: (path: string) => void;
	removeClaudeProjectRoot: (path: string) => void;
	updateClaudeProjectRoot: (oldPath: string, newPath: string) => void;
	resetClaudeProjectRoots: () => void;
	claudeWatchEnabled: boolean;
	setClaudeWatchEnabled: (enabled: boolean) => void;

	// ─── Onboarding ──────────────────────────────────────────────────────
	onboarding: OnboardingState;
	/** Mark the wizard as having started (sets `startedAt` if not already set,
	 * flips current step to in_progress). Idempotent. */
	startOnboarding: (mode?: OnboardingState['mode']) => void;
	setOnboardingPayload: <P>(stepId: OnboardingStepId, payload: P) => void;
	setSelectedAgentId: (id: string | null) => void;
	markOnboardingStepCompleted: (stepId: OnboardingStepId) => void;
	markOnboardingStepSkipped: (stepId: OnboardingStepId) => void;
	setOnboardingActiveIndex: (idx: number) => void;
	/** Re-enter the wizard at a specific step in edit mode (from Settings). */
	enterOnboardingEdit: (stepId: OnboardingStepId) => void;
	/** Mark every step as completed and stamp completedAt — called from the
	 * summary step's "Open workspace" terminal action. */
	finishOnboarding: () => void;
	/** Reset the wizard to a fresh first-run state — used by Settings
	 * "Start over". */
	resetOnboarding: () => void;
}

function clampActiveIndex(idx: number): number {
	if (Number.isNaN(idx) || idx < 0) return 0;
	if (idx > ONBOARDING_STEPS.length - 1) return ONBOARDING_STEPS.length - 1;
	return idx;
}

// Exposed for unit tests. Zustand's `persist` middleware doesn't surface
// the migrate fn through a clean public API, so we hoist the logic into
// a named helper and reference it from both the `persist({ migrate })`
// option and the tests.
export function migrateShellStore(persisted: unknown, _version: number): unknown {
	const p = (persisted ?? {}) as Partial<ShellState> & {
		activeMode?: string;
		agent_onboarded?: boolean;
		selected_agent_id?: string | null;
		onboarding?: Partial<OnboardingState>;
	};

	// v7 carry-over: snap stale activeMode → 'app'.
	const valid: ActivityMode[] = ['app', 'files', 'sessions', 'settings'];
	if (p.activeMode && !valid.includes(p.activeMode as ActivityMode)) {
		p.activeMode = 'app';
	}

	// v8: build OnboardingState from defaults + legacy keys if present.
	if (!p.onboarding) {
		const next = createDefaultOnboardingState();
		const hadLegacyAgent = p.agent_onboarded === true;
		const legacyAgentId =
			typeof p.selected_agent_id === 'string' && p.selected_agent_id.length > 0
				? p.selected_agent_id
				: null;

		if (hadLegacyAgent || legacyAgentId) {
			if (hadLegacyAgent) {
				next.steps.agent = {
					status: 'completed',
					completedAt: Date.now(),
					payload: legacyAgentId ? { agentId: legacyAgentId } : undefined,
				};
			}
			if (legacyAgentId) {
				next.selectedAgentId = legacyAgentId;
			}
		}
		p.onboarding = next;
	} else {
		// Defensive: legacy installs may have a partial onboarding blob
		// from a hand-edit. Merge over defaults so missing step records
		// get filled in.
		const defaults = createDefaultOnboardingState();
		const merged: OnboardingState = {
			...defaults,
			...(p.onboarding as OnboardingState),
			steps: {
				...defaults.steps,
				...((p.onboarding as OnboardingState).steps ?? {}),
			},
		};
		merged.activeIndex = clampActiveIndex(merged.activeIndex);
		p.onboarding = merged;
	}

	// Drop the legacy flat keys so they don't get reused on next load.
	delete p.agent_onboarded;
	delete p.selected_agent_id;

	return p;
}

export const useShellStore = create<ShellState>()(
	persist(
		(set, get) => ({
			activeMode: 'app',
			setActiveMode: (activeMode) => set({ activeMode }),

			fileRoots: [...DEFAULT_FILE_ROOTS],
			addFileRoot: (path) => {
				const trimmed = path.trim();
				if (!trimmed) return;
				if (get().fileRoots.includes(trimmed)) return;
				set({ fileRoots: [...get().fileRoots, trimmed] });
			},
			removeFileRoot: (path) => set({ fileRoots: get().fileRoots.filter((r) => r !== path) }),
			updateFileRoot: (oldPath, newPath) => {
				const trimmed = newPath.trim();
				if (!trimmed || trimmed === oldPath) return;
				const cur = get().fileRoots;
				const idx = cur.indexOf(oldPath);
				if (idx < 0) return;
				// Don't allow renaming on top of another existing entry.
				if (cur.includes(trimmed)) return;
				const next = [...cur];
				next[idx] = trimmed;
				set({ fileRoots: next });
			},
			resetFileRoots: () => set({ fileRoots: [...DEFAULT_FILE_ROOTS] }),

			claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS],
			addClaudeProjectRoot: (path) => {
				const trimmed = path.trim();
				if (!trimmed) return;
				if (get().claudeProjectRoots.includes(trimmed)) return;
				set({ claudeProjectRoots: [...get().claudeProjectRoots, trimmed] });
			},
			removeClaudeProjectRoot: (path) =>
				set({ claudeProjectRoots: get().claudeProjectRoots.filter((r) => r !== path) }),
			updateClaudeProjectRoot: (oldPath, newPath) => {
				const trimmed = newPath.trim();
				if (!trimmed || trimmed === oldPath) return;
				const cur = get().claudeProjectRoots;
				const idx = cur.indexOf(oldPath);
				if (idx < 0) return;
				if (cur.includes(trimmed)) return;
				const next = [...cur];
				next[idx] = trimmed;
				set({ claudeProjectRoots: next });
			},
			resetClaudeProjectRoots: () => set({ claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS] }),
			claudeWatchEnabled: true,
			setClaudeWatchEnabled: (claudeWatchEnabled) => set({ claudeWatchEnabled }),

			// ─── Onboarding actions ────────────────────────────────────────
			onboarding: createDefaultOnboardingState(),

			startOnboarding: (mode = 'first_run') =>
				set((state) => {
					const ob = state.onboarding;
					const startedAt = ob.startedAt ?? Date.now();
					const activeId = ONBOARDING_STEPS[clampActiveIndex(ob.activeIndex)]!;
					const currentRecord = ob.steps[activeId];
					const nextSteps =
						currentRecord.status === 'pending'
							? { ...ob.steps, [activeId]: { ...currentRecord, status: 'in_progress' as const } }
							: ob.steps;
					return {
						onboarding: {
							...ob,
							mode,
							startedAt,
							steps: nextSteps,
						},
					};
				}),

			setOnboardingPayload: (stepId, payload) =>
				set((state) => {
					const ob = state.onboarding;
					const existing = ob.steps[stepId];
					return {
						onboarding: {
							...ob,
							steps: {
								...ob.steps,
								[stepId]: { ...existing, payload },
							},
						},
					};
				}),

			setSelectedAgentId: (id) =>
				set((state) => ({ onboarding: { ...state.onboarding, selectedAgentId: id } })),

			markOnboardingStepCompleted: (stepId) =>
				set((state) => {
					const ob = state.onboarding;
					const existing = ob.steps[stepId];
					return {
						onboarding: {
							...ob,
							steps: {
								...ob.steps,
								[stepId]: {
									...existing,
									status: 'completed',
									completedAt: Date.now(),
								},
							},
						},
					};
				}),

			markOnboardingStepSkipped: (stepId) =>
				set((state) => {
					const ob = state.onboarding;
					// Only optional steps may be skipped. Caller is expected to gate
					// this in the UI; the action enforces it defensively.
					if (!OPTIONAL_ONBOARDING_STEPS.has(stepId)) return state;
					const existing = ob.steps[stepId];
					return {
						onboarding: {
							...ob,
							steps: {
								...ob.steps,
								[stepId]: {
									...existing,
									status: 'skipped',
									completedAt: Date.now(),
								},
							},
						},
					};
				}),

			setOnboardingActiveIndex: (idx) =>
				set((state) => ({
					onboarding: {
						...state.onboarding,
						activeIndex: clampActiveIndex(idx),
					},
				})),

			enterOnboardingEdit: (stepId) =>
				set((state) => {
					const idx = ONBOARDING_STEPS.indexOf(stepId);
					if (idx < 0) return state;
					return {
						onboarding: {
							...state.onboarding,
							mode: 'edit',
							activeIndex: idx,
						},
					};
				}),

			finishOnboarding: () =>
				set((state) => ({
					onboarding: {
						...state.onboarding,
						completedAt: Date.now(),
						activeIndex: ONBOARDING_STEPS.length - 1,
					},
				})),

			resetOnboarding: () => set({ onboarding: createDefaultOnboardingState() }),
		}),
		// Bump version when ActivityMode union or persisted shape changes.
		// v5: mail/outbox/studio promoted to CoreMode (then v7 narrowed).
		// v6: added claudeProjectRoots / claudeWatchEnabled.
		// v7: strip-down — CoreMode narrowed to {app, files, sessions, settings};
		//     migrate snaps any stale persisted activeMode (mail/outbox/studio/
		//     agents/mini-app names) → 'app' so users coming from the legacy
		//     shell don't crash on an invalid persisted union value.
		// v8: onboarding wizard scaffold — added `onboarding` slice. Migrates
		//     legacy `agent_onboarded` / `selected_agent_id` keys (from the
		//     predecessor onboarding plan) into the new OnboardingState.
		{
			name: 'shell-store',
			version: 8,
			migrate: (persisted, version) => migrateShellStore(persisted, version) as ShellState,
		}
	)
);
