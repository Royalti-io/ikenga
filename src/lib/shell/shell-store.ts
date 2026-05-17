import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
	fsRootsAdd,
	fsRootsList,
	fsRootsRemove,
	fsRootsReset,
	type Project,
	projectGetActive,
	projectList,
	projectSetActive,
	settingsGetAll,
	settingsSet,
} from '@/lib/tauri-cmd';

// ─── Tauri-backed settings_kv mirror keys ─────────────────────────────────
//
// Zustand's `persist` middleware keeps these in localStorage for instant
// first-paint hydration; settings_kv (migration 0013) is the durable copy
// that survives "Clear local data" and can later back cross-device sync.
// Frontend hydrates from Tauri at boot (hydrateSettingsFromRust) and
// write-throughs on every relevant setter.

const KV_TELEMETRY = 'telemetry.enabled';
const KV_CHAT_ADAPTER = 'agent.chatAdapterId';
const KV_CLAUDE_ROOTS = 'claude.projectRoots';
const KV_CLAUDE_WATCH = 'claude.watchEnabled';
const KV_ONBOARDING = 'onboarding.state';

// Set true while pulling values from Rust into the store so the
// subscribe-based onboarding mirror doesn't push them straight back.
let suppressKv = false;

function kvSet(key: string, value: unknown): void {
	if (suppressKv) return;
	settingsSet(key, JSON.stringify(value)).catch(() => {
		// Tauri unavailable (test env / pre-setup) — localStorage is still
		// the in-page cache so the user's edit is not lost.
	});
}

function parseKv<T>(raw: string | undefined): T | undefined {
	if (raw == null) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

// Post-strip: only 4 first-class workspaces. Mail / Outbox / Studio /
// Agents were app-pkg surfaces and got removed with the strip-down.
// Mini-apps are gone too — they were placeholders for media tooling
// that lives in app pkgs now.
export type CoreMode = 'app' | 'files' | 'sessions' | 'artifact-grid' | 'pkgs' | 'settings';
export type ActivityMode = CoreMode;

// Default file roots. Kept in sync with `src-tauri/src/fs_roots.rs::DEFAULT_ROOTS`;
// the Rust side is authoritative — these are only the seed values used by the
// onboarding wizard's "reset to defaults" affordance and the test harness.
// At runtime, `fileRoots` is hydrated from Rust on app boot (see
// `hydrateFileRootsFromRust`).
//
// Empty by design: a fresh install has no allowlist until the user adds a
// root via the onboarding wizard or Settings → Storage.
export const DEFAULT_FILE_ROOTS: readonly string[] = Object.freeze([]);

// Project roots scanned by the /claude config browser. Each root is a dir
// that contains a `.claude/` subfolder (agents/skills/commands/settings).
// Personal `~/.claude/` is always scanned in addition to these — it doesn't
// need to be listed. Empty by default; the user adds roots via onboarding
// step "roots" or Settings.
export const DEFAULT_CLAUDE_PROJECT_ROOTS: readonly string[] = Object.freeze([]);

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

	// ─── Telemetry consent ───────────────────────────────────────────────
	// Canonical home for the telemetry preference. The onboarding wizard's
	// `telemetry` step writes to this field directly so Settings → Privacy
	// reads the same source. Default OFF — APPROVAL.md, no dark patterns.
	telemetryConsent: boolean;
	setTelemetryConsent: (enabled: boolean) => void;

	// ─── Chat adapter ────────────────────────────────────────────────────
	// Which engine adapter pkg drives the chat surface. Mirrors the
	// agent step's `selectedAgentId` after onboarding completes; left
	// null when the user picks offline mode.
	chatAdapterId: string | null;
	setChatAdapterId: (id: string | null) => void;

	fileRoots: string[];
	addFileRoot: (path: string) => void;
	removeFileRoot: (path: string) => void;
	/** Replace `oldPath` with `newPath` (no-op if oldPath isn't present, or if
	 * the new path is empty / a duplicate of an existing entry). Used by the
	 * editable settings selectors. */
	updateFileRoot: (oldPath: string, newPath: string) => void;
	resetFileRoots: () => void;
	/** Pull the authoritative list from Rust (`fs_roots_list`) and overwrite
	 * local state. Called at app boot; safe to call multiple times. Rejects
	 * silently in non-Tauri test environments. */
	hydrateFileRootsFromRust: () => Promise<void>;

	claudeProjectRoots: string[];
	addClaudeProjectRoot: (path: string) => void;
	removeClaudeProjectRoot: (path: string) => void;
	updateClaudeProjectRoot: (oldPath: string, newPath: string) => void;
	resetClaudeProjectRoots: () => void;
	claudeWatchEnabled: boolean;
	setClaudeWatchEnabled: (enabled: boolean) => void;

	/** Which Claude config browser surface is active. 'layered' uses the
	 * 4-tier discovery (Phase 4); 'roots' is the legacy 2-tier scan kept
	 * around as a fallback. UI-only preference, persisted via Zustand. */
	claudeBrowserMode: 'layered' | 'roots';
	setClaudeBrowserMode: (mode: 'layered' | 'roots') => void;

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

	/** Pull durable settings from Rust (settings_kv) and overwrite local
	 * state. If settings_kv is empty, push the currently-persisted Zustand
	 * snapshot in once so existing users carry over. Called once at app
	 * boot from `main.tsx`; safe to call multiple times. Rejects silently
	 * in non-Tauri test environments. */
	hydrateSettingsFromRust: () => Promise<void>;

	// ─── Projects (Phase 0 — first-class) ─────────────────────────────────
	// The Rust side owns the durable list (migration 0015) and the active
	// project id (settings_kv `shell.activeProjectId`). Persistence is not
	// duplicated in Zustand — these fields live in memory only, hydrated
	// at boot from `refreshProjects`.
	projects: Project[];
	activeProjectId: string;
	/** Switch the active project. Updates Rust side first, then refreshes
	 *  the local list. The Rust emit of `projects:active-changed` is what
	 *  drives TanStack invalidation in the workspace-level listener. */
	setActiveProject: (id: string) => Promise<void>;
	/** Pull the project list + active project id from Rust. Safe to call
	 *  multiple times; rejects silently in non-Tauri test environments. */
	refreshProjects: () => Promise<void>;
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

	// v7 carry-over: snap stale activeMode → 'app'. v10 widens valid set to
	// include 'pkgs' (registry browser activity-bar entry). v11 widens
	// again with 'artifact-grid' (projects-and-artifact-wizard plan §B2).
	const valid: ActivityMode[] = ['app', 'files', 'sessions', 'artifact-grid', 'pkgs', 'settings'];
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

	// v9 carry-over: seed canonical telemetry consent + chat adapter from
	// the onboarding payload when they're missing on disk. Lets the
	// onboarding step writes flow into settings without losing existing
	// preferences for users mid-upgrade.
	const px = p as Partial<ShellState> & {
		onboarding?: OnboardingState;
		telemetryConsent?: boolean;
		chatAdapterId?: string | null;
	};
	if (typeof px.telemetryConsent !== 'boolean') {
		const fromOnboarding = (
			px.onboarding?.steps?.telemetry?.payload as { enabled?: boolean } | undefined
		)?.enabled;
		px.telemetryConsent = typeof fromOnboarding === 'boolean' ? fromOnboarding : false;
	}
	if (typeof px.chatAdapterId === 'undefined') {
		px.chatAdapterId = px.onboarding?.selectedAgentId ?? null;
	}

	return p;
}

export const useShellStore = create<ShellState>()(
	persist(
		(set, get) => ({
			activeMode: 'app',
			setActiveMode: (activeMode) => set({ activeMode }),

			telemetryConsent: false,
			setTelemetryConsent: (telemetryConsent) => {
				set({ telemetryConsent });
				kvSet(KV_TELEMETRY, telemetryConsent);
			},

			chatAdapterId: null,
			setChatAdapterId: (chatAdapterId) => {
				set({ chatAdapterId });
				kvSet(KV_CHAT_ADAPTER, chatAdapterId);
			},

			fileRoots: [...DEFAULT_FILE_ROOTS],
			// All four mutators update local state optimistically for instant UI
			// feedback, then sync the authoritative list back from Rust. The
			// invoke promise is swallowed in non-Tauri test environments so the
			// existing unit tests (which never see a Tauri runtime) still pass.
			addFileRoot: (path) => {
				const trimmed = path.trim();
				if (!trimmed) return;
				if (!get().fileRoots.includes(trimmed)) {
					set({ fileRoots: [...get().fileRoots, trimmed] });
				}
				fsRootsAdd(trimmed)
					.then((next) => set({ fileRoots: next }))
					.catch(() => {});
			},
			removeFileRoot: (path) => {
				set({ fileRoots: get().fileRoots.filter((r) => r !== path) });
				fsRootsRemove(path)
					.then((next) => set({ fileRoots: next }))
					.catch(() => {});
			},
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
				// Rust has no atomic "rename" — sequence remove+add. If the
				// remove succeeds but add fails (e.g. invalid path), the user
				// sees a shorter list, matching the local state we already set.
				fsRootsRemove(oldPath)
					.then(() => fsRootsAdd(trimmed))
					.then((latest) => set({ fileRoots: latest }))
					.catch(() => {});
			},
			resetFileRoots: () => {
				set({ fileRoots: [...DEFAULT_FILE_ROOTS] });
				fsRootsReset()
					.then((next) => set({ fileRoots: next }))
					.catch(() => {});
			},
			hydrateFileRootsFromRust: async () => {
				try {
					const next = await fsRootsList();
					set({ fileRoots: next });
				} catch {
					// Test environment or pre-setup boot — keep the persisted
					// snapshot. Caller can retry.
				}
			},

			claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS],
			addClaudeProjectRoot: (path) => {
				const trimmed = path.trim();
				if (!trimmed) return;
				if (get().claudeProjectRoots.includes(trimmed)) return;
				const next = [...get().claudeProjectRoots, trimmed];
				set({ claudeProjectRoots: next });
				kvSet(KV_CLAUDE_ROOTS, next);
			},
			removeClaudeProjectRoot: (path) => {
				const next = get().claudeProjectRoots.filter((r) => r !== path);
				set({ claudeProjectRoots: next });
				kvSet(KV_CLAUDE_ROOTS, next);
			},
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
				kvSet(KV_CLAUDE_ROOTS, next);
			},
			resetClaudeProjectRoots: () => {
				const next = [...DEFAULT_CLAUDE_PROJECT_ROOTS];
				set({ claudeProjectRoots: next });
				kvSet(KV_CLAUDE_ROOTS, next);
			},
			claudeWatchEnabled: true,
			setClaudeWatchEnabled: (claudeWatchEnabled) => {
				set({ claudeWatchEnabled });
				kvSet(KV_CLAUDE_WATCH, claudeWatchEnabled);
			},

			claudeBrowserMode: 'layered',
			setClaudeBrowserMode: (claudeBrowserMode) => {
				set({ claudeBrowserMode });
			},

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

			// ─── Projects ─────────────────────────────────────────────────
			// Boot value is the bootstrap default — Rust always seeds a
			// `default` row in migration 0015, and the active id is the
			// same until the user picks something else. `refreshProjects`
			// at boot replaces both fields with the authoritative copy.
			projects: [],
			activeProjectId: 'default',
			setActiveProject: async (id: string) => {
				// Optimistic local update so the activity-bar indicator and
				// any indicator-derived UI flip instantly. Rust emits the
				// `projects:active-changed` event which the workspace-level
				// listener uses to invalidate project-scoped queries.
				const prev = get().activeProjectId;
				if (prev === id) return;
				set({ activeProjectId: id });
				try {
					await projectSetActive(id);
				} catch (err) {
					// Roll back the optimistic flip — but only if nobody
					// flipped again in the meantime.
					if (get().activeProjectId === id) {
						set({ activeProjectId: prev });
					}
					throw err;
				}
			},
			refreshProjects: async () => {
				try {
					const [list, active] = await Promise.all([projectList(true), projectGetActive()]);
					set({ projects: list, activeProjectId: active.id });
				} catch {
					// Tauri unavailable (test env / pre-setup boot).
				}
			},

			hydrateSettingsFromRust: async () => {
				let all: Record<string, string> = {};
				try {
					all = await settingsGetAll();
				} catch {
					// Tauri unavailable (test env or pre-setup boot).
					return;
				}
				if (Object.keys(all).length === 0) {
					// First boot post-migration: seed settings_kv from whatever
					// localStorage hydrated us with so existing users carry over.
					const s = get();
					suppressKv = true;
					try {
						kvSet(KV_TELEMETRY, s.telemetryConsent);
						kvSet(KV_CHAT_ADAPTER, s.chatAdapterId);
						kvSet(KV_CLAUDE_ROOTS, s.claudeProjectRoots);
						kvSet(KV_CLAUDE_WATCH, s.claudeWatchEnabled);
						kvSet(KV_ONBOARDING, s.onboarding);
					} finally {
						suppressKv = false;
					}
					return;
				}
				// Tauri has values — overwrite the relevant store slices.
				suppressKv = true;
				try {
					const next: Partial<ShellState> = {};
					const tel = parseKv<boolean>(all[KV_TELEMETRY]);
					if (typeof tel === 'boolean') next.telemetryConsent = tel;
					const adapter = parseKv<string | null>(all[KV_CHAT_ADAPTER]);
					if (adapter === null || typeof adapter === 'string') {
						next.chatAdapterId = adapter;
					}
					const roots = parseKv<string[]>(all[KV_CLAUDE_ROOTS]);
					if (Array.isArray(roots)) next.claudeProjectRoots = roots;
					const watch = parseKv<boolean>(all[KV_CLAUDE_WATCH]);
					if (typeof watch === 'boolean') next.claudeWatchEnabled = watch;
					const ob = parseKv<OnboardingState>(all[KV_ONBOARDING]);
					if (ob && typeof ob === 'object') next.onboarding = ob;
					set(next);
				} finally {
					suppressKv = false;
				}
			},
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
		// v9: canonical telemetry consent + chat adapter id. Seeded from any
		//     existing onboarding payload so user choices survive the bump.
		// v10: widen CoreMode with 'pkgs' for the registry browser activity-bar
		//     entry. Migrate keeps the same valid-set check, just widened.
		// v11: widen CoreMode with 'artifact-grid' for the artifact-grid
		//     activity-bar entry (projects-and-artifact-wizard plan §B2).
		{
			name: 'shell-store',
			version: 11,
			migrate: (persisted, version) => migrateShellStore(persisted, version) as ShellState,
		}
	)
);

// Mirror the onboarding slice into settings_kv whenever it changes. Covers
// every onboarding mutator (startOnboarding, setOnboardingPayload,
// setSelectedAgentId, mark*StepCompleted/Skipped, setOnboardingActiveIndex,
// enterOnboardingEdit, finishOnboarding, resetOnboarding) without each
// mutator having to opt in. Suppressed during `hydrateSettingsFromRust` so
// we don't push the value we just pulled.
useShellStore.subscribe((state, prev) => {
	if (state.onboarding !== prev.onboarding) {
		kvSet(KV_ONBOARDING, state.onboarding);
	}
});
