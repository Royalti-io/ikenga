// Per-agent glyph for the wizard chip + onboarding cards.
//
// Brand engines use `@lobehub/icons` color variants (Claude, OpenAI/Codex,
// Gemini). `chat` and `custom` aren't brands so they keep lucide glyphs
// (MessageSquare, Wrench). Single export point so consumers don't think
// about the icon source.

import { MessageSquare, Wrench } from 'lucide-react';
import Claude from '@lobehub/icons/es/Claude';
import Codex from '@lobehub/icons/es/Codex';
import Gemini from '@lobehub/icons/es/Gemini';

import type { AgentChoice } from '@/shell/artifact-wizard/scaffold';

type AgentKind = AgentChoice['kind'];

export function AgentIcon({
	kind,
	className,
	size,
}: {
	kind: AgentKind;
	className?: string;
	size?: number;
}) {
	const px = size ?? 14;
	switch (kind) {
		case 'chat':
			return <MessageSquare className={className} width={px} height={px} />;
		case 'claude':
			return <Claude.Color size={px} className={className} />;
		case 'codex':
			return <Codex.Avatar size={px} className={className} />;
		case 'gemini':
			return <Gemini.Color size={px} className={className} />;
		case 'custom':
			return <Wrench className={className} width={px} height={px} />;
	}
}
