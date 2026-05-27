// Brand-logo glyph for an Ngwa engine tile (`.eg` / `.ngwa-eg` / `.ngwa-eb`).
//
// Renders the real Claude / Gemini / Codex mark in its original brand colour
// (the `.Color` variant), shown bare (no tinted box — see the CSS that drops the
// `.eg` tile background) instead of the 2-char `CL`/`GM`/`CX` text badge. Matches the locked designs
// `designs/cross-system-facet.html` (D-08) + `designs/write-transcode-drawer.html`
// (D-09), which render the `#lg-claude` / `#lg-gemini` / `#lg-codex` brand
// symbols in those tiles. Same `@lobehub/icons` source the onboarding
// (`engine-logo.tsx`) and artifact-wizard (`agent-icon.tsx`) already use.

import Claude from '@lobehub/icons/es/Claude';
import Codex from '@lobehub/icons/es/Codex';
import Gemini from '@lobehub/icons/es/Gemini';

import type { NgwaSystemId } from './ngwa-surface';

export function EngineGlyph({
	system,
	size = 14,
	className,
}: {
	system: NgwaSystemId;
	size?: number;
	className?: string;
}) {
	switch (system) {
		case 'claude':
			return <Claude.Color size={size} className={className} />;
		case 'gemini':
			return <Gemini.Color size={size} className={className} />;
		case 'codex':
			return <Codex.Color size={size} className={className} />;
	}
}
