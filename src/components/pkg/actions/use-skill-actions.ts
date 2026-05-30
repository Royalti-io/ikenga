// WP-13: load the skill actions a `kind: skill` pkg contributes.
//
// Backed by the Rust `list_skill_actions` command (wrapped as `listSkillActions`
// in tauri-cmd.ts), which parses `<skills_dir>/<skill>/actions/*.md` frontmatter.
// Returns an empty list for non-skill pkgs, so the ActionBar can mount
// unconditionally and simply render nothing when there's nothing to show.

import { useEffect, useState } from 'react';

import { listSkillActions, type SkillAction } from '@/lib/tauri-cmd';

export interface UseSkillActionsResult {
	actions: SkillAction[];
	loading: boolean;
	error: string | null;
}

export function useSkillActions(pkgId: string | null): UseSkillActionsResult {
	const [actions, setActions] = useState<SkillAction[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!pkgId) {
			setActions([]);
			setLoading(false);
			setError(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		listSkillActions(pkgId)
			.then((result) => {
				if (cancelled) return;
				setActions(result ?? []);
				setLoading(false);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setActions([]);
				setError(e instanceof Error ? e.message : String(e));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [pkgId]);

	return { actions, loading, error };
}
