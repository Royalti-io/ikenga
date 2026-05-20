// Brand logo for an onboarding engine row.
//
// Maps the onboarding's engine ids (claude-code, codex, gemini,
// cursor-agent, ollama) to `@lobehub/icons` color variants. Unknown ids
// fall back to a question-mark glyph so we don't crash on a future
// engine that hasn't been wired yet.

import { HelpCircle } from 'lucide-react';
import Claude from '@lobehub/icons/es/Claude';
import Codex from '@lobehub/icons/es/Codex';
import Cursor from '@lobehub/icons/es/Cursor';
import Gemini from '@lobehub/icons/es/Gemini';
import Ollama from '@lobehub/icons/es/Ollama';

export type EngineId =
	| 'claude-code'
	| 'codex'
	| 'gemini'
	| 'cursor-agent'
	| 'ollama'
	| (string & {});

export function EngineLogo({
	engineId,
	size,
	className,
}: {
	engineId: EngineId;
	size?: number;
	className?: string;
}) {
	const px = size ?? 22;
	// Use the `.Avatar` variant uniformly — Cursor and Ollama only ship that
	// shape, and using Avatar everywhere keeps the onboarding cards visually
	// consistent (all show as filled square brand tiles in the 9×9 slot).
	switch (engineId) {
		case 'claude-code':
			return <Claude.Avatar size={px} className={className} />;
		case 'codex':
			return <Codex.Avatar size={px} className={className} />;
		case 'gemini':
			return <Gemini.Avatar size={px} className={className} />;
		case 'cursor-agent':
			return <Cursor.Avatar size={px} className={className} />;
		case 'ollama':
			return <Ollama.Avatar size={px} className={className} />;
		default:
			return <HelpCircle width={px} height={px} className={className} />;
	}
}
