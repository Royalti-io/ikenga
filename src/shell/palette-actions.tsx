// WP-18a — the ⌘K palette "Actions" group.
//
// Pulls every installed skill's actions (the same `list_all_skill_actions`
// Tauri command the skill-action button bar uses) up into the shipped command
// palette as a first-class group that slots BETWEEN the pane-local group and
// Navigate. cmdk owns ranking on a typed query; the group's position is only
// the tiebreaker (pane creation stays top for muscle memory, verbs that do
// work come next, raw route nav sinks to the bottom).
//
// ENTER routes through the *existing* `dispatchAction()` (action-runner.ts) —
// NOT a fork. `confirm` seeds the New-Session dialog with the prompt template;
// `approve` runs and its drafts pause at /outbox/approvals via the
// `pa-action-paused` event. Both are dispatchable today; `streaming` / `form`
// / `silent` render visible-but-disabled with a mode badge exactly like
// `ActionButton` does, so the operator sees the capability is coming.
//
// Design: plans/atelier-parity/designs/parity-palette-actions.html.

import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
	CheckSquare,
	FileText,
	type LucideIcon,
	Mail,
	Search,
	Send,
	Sparkles,
	Target,
	TrendingUp,
	Users,
} from 'lucide-react';
import { CommandRow } from '@/components/ui/command-row';
import { dispatchAction, isDispatchable } from '@/components/pkg/actions/action-runner';
import { queryKeys } from '@/lib/query-keys';
import { listAllSkillActions, type SkillAction } from '@/lib/tauri-cmd';

// Domain → leading glyph. Presentation-only (the manifest has no per-action
// icon field); a design choice, not a data field. Unknown / absent domains
// fall back to the generic skill spark. See the design's open questions.
const DOMAIN_ICONS: Record<string, LucideIcon> = {
	mail: Mail,
	outbound: Send,
	finance: TrendingUp,
	tasks: CheckSquare,
	sales: Users,
	content: FileText,
	research: Search,
	strategy: Target,
};

function iconForDomain(domain: string | undefined): LucideIcon {
	return (domain && DOMAIN_ICONS[domain]) || Sparkles;
}

// ux_mode → chip colour, keyed to the mode's dispatch character. Anchored to
// the live Dusk Wood tokens (--agent / --live / --achievement / --primary /
// --systemic, all shipped in @ikenga/tokens). confirm+approve dispatch today;
// the rest are the deferred (disabled) modes.
const UX_MODE_TOKEN: Record<string, string> = {
	confirm: '--agent',
	approve: '--live',
	streaming: '--achievement',
	form: '--primary',
	silent: '--systemic',
};

function UxModeChip({ uxMode, disabled }: { uxMode: string; disabled: boolean }) {
	const token = UX_MODE_TOKEN[uxMode] ?? '--fg-muted';
	return (
		<span
			className="shrink-0 rounded-[var(--radius-xs)] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide"
			style={{
				color: `var(${token})`,
				borderColor: `var(${token}-soft)`,
				backgroundColor: `var(${token}-soft)`,
			}}
		>
			{uxMode}
			{disabled && <span className="ml-1 text-[8px] opacity-70">soon</span>}
		</span>
	);
}

function DomainChip({ domain }: { domain: string }) {
	return (
		<span className="shrink-0 rounded-[var(--radius-xs)] border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
			{domain}
		</span>
	);
}

/**
 * Every installed skill's actions. No pkg-install Tauri event exists to
 * invalidate on, so this leans on a ~30s staleTime (design default). Refetches
 * on window refocus like every other query, and any future pkg-install event
 * can invalidate `queryKeys.skillActions.all`.
 */
export function useAllSkillActions() {
	return useQuery({
		queryKey: queryKeys.skillActions.all,
		queryFn: listAllSkillActions,
		staleTime: 30_000,
	});
}

/** Stable cmdk key / React key for an action — `skill/verb` is the same stable
 *  key the ActionBar uses; scope with pkgId so two pkgs sharing a skill dir
 *  never collide. */
function actionKey(a: SkillAction): string {
	return `${a.pkgId}::${a.skill}/${a.verb}`;
}

/**
 * The "Actions" group. Renders nothing when no installed skill contributes
 * actions (a fresh install with only builtin pkgs) — the header is omitted
 * entirely and the rest of the palette is untouched, mirroring `ActionBar`
 * returning null on an empty list. Only mounted in `mode: 'all'` by the caller.
 */
export function ActionsGroup({ onClose }: { onClose: () => void }) {
	const { data } = useAllSkillActions();
	const actions = data ?? [];
	if (actions.length === 0) return null;

	function dispatch(action: SkillAction) {
		// Close the palette first (like every other row via onClose →
		// onOpenChange(false)); defer the dispatch a tick so the palette unmounts
		// before the New-Session dialog grabs focus — same focus-ping-pong guard
		// the `go()` navigations use. `dispatchAction` stamps the source
		// (`skill-action` vs `approve-action`) and opens the shared dialog; for
		// `approve` the run then pauses at the gate via `pa-action-paused`.
		onClose();
		setTimeout(() => {
			void dispatchAction(action);
		}, 0);
	}

	return (
		<Command.Group heading="Actions" className="text-xs text-muted-foreground">
			{actions.map((action) => {
				const canDispatch = isDispatchable(action);
				const Icon = iconForDomain(action.domain);
				return (
					<CommandRow
						key={actionKey(action)}
						size="md"
						value={`${action.name} ${action.skill} ${action.verb} ${action.domain ?? ''}`}
						Icon={Icon}
						label={action.name}
						detail={`${action.skill} / ${action.verb}`}
						disabled={!canDispatch}
						onSelect={canDispatch ? () => dispatch(action) : () => {}}
						trailing={
							<>
								{action.domain && <DomainChip domain={action.domain} />}
								<UxModeChip uxMode={action.uxMode} disabled={!canDispatch} />
							</>
						}
					/>
				);
			})}
		</Command.Group>
	);
}
