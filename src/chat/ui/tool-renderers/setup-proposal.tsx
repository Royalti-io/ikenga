// WP-18b R9 (design-mapped location) — the tool-renderer that slots the setup
// proposal card into the chat thread via the existing tool-renderer registry
// (no thread.tsx diff). It adapts a `PairedToolCall` from the setup "propose"
// tool into `<SetupChatPanel>` props and threads the active project root.
//
// The presentational + confirm-write core lives in
// `src/shell/atelier/surfaces/setup-chat-panel.tsx` (the task's mapped surface
// home); this file is the thin chat-side adapter the design pins at
// `chat/ui/tool-renderers/setup-proposal.tsx`.
//
// DORMANCY NOTE: the setup "propose" MCP tool does not exist yet (its name is a
// flagged placeholder in the design; it is a T2 mcp-iyke dependency). Until it
// ships, no live conversation emits a tool_use with a matching name, so this
// renderer never fires in the wild — an unknown tool safely falls through to
// `generic-json.tsx` (the design's stated safe degradation). The matching name
// set below is the seam to activate once the tool name is finalized at build.

import { useShellStore } from '@/lib/shell/shell-store';
import {
	type ProposalField,
	type SetupProposal,
	SetupChatPanel,
} from '@/shell/atelier/surfaces/setup-chat-panel';
import type { PairedToolCall } from '../../store';

/** Candidate tool names for the setup proposal. The design flags the exact name
 *  (`atelier_setup.propose` / `atelier_write_instance`) as a build-time
 *  placeholder, so match a small set plus a trailing-token fallback (mirrors how
 *  `ask-user-question` matches `*AskUserQuestion`). */
const SETUP_PROPOSE_NAMES = new Set([
	'atelier_setup.propose',
	'atelier_setup_propose',
	'atelier_write_instance',
]);

export function isSetupProposeTool(name: string): boolean {
	if (SETUP_PROPOSE_NAMES.has(name)) return true;
	const tail = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
	return tail === 'propose' || tail.endsWith('setup_propose') || tail.endsWith('write_instance');
}

/** Split an authored skill id into its `.atelier/` path segment and its envelope
 *  `skill` value. The reader convention keys the segment as `skill-<id>` (e.g.
 *  `skill-tasks`), while §6's byte example writes the bare id (`"mail"`) into the
 *  envelope. Accepts either form on input. */
export function deriveSkillIdentity(raw: string): { segment: string; id: string } {
	const segment = raw.startsWith('skill-') ? raw : `skill-${raw}`;
	const id = segment.replace(/^skill-/, '');
	return { segment, id };
}

interface ProposeInput {
	skill?: string;
	template_version?: number;
	prior_version?: number;
	file?: string;
	settings?: Record<string, unknown>;
	/** Optional per-field provenance, keyed by settings key. */
	sources?: Record<string, string>;
	/** Optional migrate hint: settings keys that are net-new in this version. */
	new_fields?: string[];
}

/** Map a tool_use input into a `SetupProposal`. Returns `null` when the input
 *  is too malformed to render a card (the dispatcher then falls back to the
 *  generic renderer). Exported for the unit test. */
export function proposalFromInput(input: unknown): SetupProposal | null {
	if (input == null || typeof input !== 'object') return null;
	const raw = input as ProposeInput;
	if (typeof raw.skill !== 'string' || raw.skill.length === 0) return null;
	const settings = raw.settings ?? {};
	const newFields = new Set(raw.new_fields ?? []);
	const fields: ProposalField[] = Object.entries(settings).map(([key, value]) => ({
		key,
		value,
		source: raw.sources?.[key],
		isNew: newFields.has(key),
	}));
	const { segment, id } = deriveSkillIdentity(raw.skill);
	return {
		skill: segment,
		skillId: id,
		templateVersion: typeof raw.template_version === 'number' ? raw.template_version : 1,
		priorVersion: typeof raw.prior_version === 'number' ? raw.prior_version : undefined,
		file: typeof raw.file === 'string' ? raw.file : undefined,
		fields,
	};
}

export function SetupProposalRenderer({ pair }: { pair: PairedToolCall }) {
	const projectRoot = useShellStore(
		(s) => s.projects.find((p) => p.id === s.activeProjectId)?.root_path ?? null
	);
	const proposal = proposalFromInput(pair.use.input);
	if (!proposal) return null;
	return <SetupChatPanel proposal={proposal} projectRoot={projectRoot} />;
}
