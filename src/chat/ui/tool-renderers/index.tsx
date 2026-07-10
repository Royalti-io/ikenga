/**
 * Per-tool renderer dispatch. Picks the right component for `pair.use.name`
 * and renders it at the requested density.
 *
 * Used by both the inline tool pill (`tool-call-card.tsx`, density='full'
 * inside the 320px scroll-cap) and the viewer pane (`tool-output-view.tsx`,
 * density='full' filling the pane).
 */

import type { PairedToolCall } from '../../store';
import { BashRenderer } from './bash';
import { ReadRenderer } from './read';
import { WriteEditRenderer } from './write-edit';
import { TaskRenderer } from './task';
import { GenericJsonRenderer } from './generic-json';
import { AskUserQuestionRenderer } from './ask-user-question';
import { isSetupProposeTool, SetupProposalRenderer } from './setup-proposal';

interface DispatchProps {
	pair: PairedToolCall;
	threadId: string;
	density: 'inline' | 'full';
}

export function ToolRendererDispatch({ pair, threadId, density }: DispatchProps) {
	const name = pair.use.name;
	if (name === 'Read') return <ReadRenderer pair={pair} density={density} />;
	if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
		return <WriteEditRenderer pair={pair} density={density} />;
	}
	if (name === 'Bash') return <BashRenderer pair={pair} density={density} />;
	if (name === 'Task') {
		return <TaskRenderer pair={pair} density={density} threadId={threadId} />;
	}
	// AskUserQuestion may be invoked under several names depending on how it's
	// registered (built-in, mcp scoped). Match on the trailing token.
	if (name === 'AskUserQuestion' || name.endsWith('AskUserQuestion')) {
		return <AskUserQuestionRenderer pair={pair} threadId={threadId} />;
	}
	// WP-18b R9: the setup proposal card (net-new). Keyed on the setup "propose"
	// tool name; unknown tools fall through to generic-json (safe degradation).
	if (isSetupProposeTool(name)) return <SetupProposalRenderer pair={pair} />;
	return <GenericJsonRenderer pair={pair} density={density} />;
}
