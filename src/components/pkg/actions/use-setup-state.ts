// WP-18b R14 — the setup-state hook.
//
// Reads the per-project instance manifest (`.atelier/<skill>/manifest.json`)
// via `atelierFileRead` and compares its `template_version` against the skill's
// declared `setup.template_version`. The result drives three surfaces:
//   • the ActionBar setup-button label ('Set up' / 'Re-run setup' / 'Migrate …'),
//   • the pkg-landing state chip (not configured / configured · vN / update available),
//   • the drift banner.
//
// Path lock + traversal guards live in the Rust `atelier_file_read` command; an
// absent or malformed file resolves to `'none'` so the button degrades to a
// fresh "Set up". Non-setup actions short-circuit to `idle` and never touch the
// filesystem.

import { useEffect, useState } from 'react';

import { useShellStore } from '@/lib/shell/shell-store';
import { atelierFileRead, type SkillAction } from '@/lib/tauri-cmd';
import { isSetupAction } from './action-runner';

export type SetupState =
	/** Not a setup action — the hook does nothing. */
	| { status: 'idle' }
	/** Instance read in flight. */
	| { status: 'loading' }
	/** No instance file yet — first-run "Set up". */
	| { status: 'none' }
	/** Instance file present, template_version current. */
	| { status: 'configured'; version: number }
	/** Instance file present but the skill shipped a newer template_version. */
	| { status: 'drift'; version: number; latest: number };

/** Derive the setup state from the raw instance-file contents (or `null` when
 *  absent) and the skill's declared latest `template_version`. Pure — exported
 *  for the unit test. A file that fails to parse, or one carrying no numeric
 *  `template_version`, is treated as `none` (a re-run rewrites it cleanly). */
export function deriveSetupState(raw: string | null, latest: number | undefined): SetupState {
	if (raw == null) return { status: 'none' };
	let version: number | null = null;
	try {
		const parsed = JSON.parse(raw) as { template_version?: unknown };
		if (typeof parsed?.template_version === 'number') version = parsed.template_version;
	} catch {
		return { status: 'none' };
	}
	if (version == null) return { status: 'none' };
	if (typeof latest === 'number' && version < latest) {
		return { status: 'drift', version, latest };
	}
	return { status: 'configured', version };
}

/** The ActionBar button label for a given setup state (R1). Falls back to
 *  "Set up" for `idle` / `loading` / `none`. */
export function setupButtonLabel(state: SetupState): string {
	switch (state.status) {
		case 'configured':
			return 'Re-run setup';
		case 'drift':
			return `Migrate v${state.version}→v${state.latest}`;
		default:
			return 'Set up';
	}
}

/** Reactive setup state for an action. Reads the active project's instance
 *  manifest; re-reads when the active project (its `root_path`), the skill, or
 *  the declared `template_version` changes. */
export function useSetupState(action: SkillAction): SetupState {
	const enabled = isSetupAction(action);
	// The generic reader keys off the active project's root_path (or null for the
	// seed Default project, which returns 'none' without filesystem access).
	const projectRoot = useShellStore(
		(s) => s.projects.find((p) => p.id === s.activeProjectId)?.root_path ?? null
	);
	const skill = action.skill;
	const latest = action.setup?.templateVersion;

	const [state, setState] = useState<SetupState>(
		enabled ? { status: 'loading' } : { status: 'idle' }
	);

	useEffect(() => {
		if (!enabled) {
			setState({ status: 'idle' });
			return;
		}
		let cancelled = false;
		setState({ status: 'loading' });
		atelierFileRead(projectRoot, skill, 'manifest.json')
			.then((raw) => {
				if (!cancelled) setState(deriveSetupState(raw, latest));
			})
			.catch(() => {
				if (!cancelled) setState({ status: 'none' });
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, projectRoot, skill, latest]);

	return state;
}
