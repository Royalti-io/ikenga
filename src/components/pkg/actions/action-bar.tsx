// WP-13: a row of skill-action buttons for a `kind: skill` pkg.
//
// Renders nothing while loading or when the pkg contributes no actions, so it's
// safe to mount unconditionally for any pkg. In WP-13 it's mounted by the pkg
// landing route (`routes/pkg/$pkgId/index.tsx`) for skill pkgs, which have no
// `ui.routes` of their own.

import { ActionButton } from '@/components/pkg/actions/action-button';
import { useSkillActions } from '@/components/pkg/actions/use-skill-actions';

export function ActionBar({ pkgId }: { pkgId: string }) {
	const { actions, loading, error } = useSkillActions(pkgId);

	if (loading || error || actions.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-2" role="group" aria-label="Skill actions">
			{actions.map((action) => (
				<ActionButton key={`${action.skill}/${action.verb}`} action={action} />
			))}
		</div>
	);
}
