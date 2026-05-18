// LoreTerm — first-contact gloss wrapper for Tier-1 lore vocabulary
// (Ikenga, Obi, Chi, Iyke, Consecration, Daily address, Share kola).
//
// On first encounter the term renders with a subtle dotted underline and
// a Radix tooltip carrying the one-line gloss from `lib/lore/glosses.json`.
// After the tooltip closes (hover-out / blur / Esc), `markGlossSeen(term)`
// records acknowledgement in `OnboardingState.loreGlossSeen`. Subsequent
// renders are plain text — the lore stays informational without nagging.
//
// Source policy: design/shell/05-lore-and-nomenclature.md §2 (Tier-1) and
// wizard-spec.md §13.4 (suppress after acknowledgement).

import * as React from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { glossFor } from '@/lib/lore';
import { useShellStore } from '@/lib/shell/shell-store';

interface LoreTermProps {
	/** The lore term key (case-insensitive). Must match an entry in glosses.json. */
	term: string;
	children?: React.ReactNode;
}

export function LoreTerm({ term, children }: LoreTermProps) {
	const loreGlossSeen = useShellStore((s) => s.onboarding.loreGlossSeen);
	const markGlossSeen = useShellStore((s) => s.markGlossSeen);

	const gloss = glossFor(term);
	const seen = (loreGlossSeen ?? []).some((t) => t.toLowerCase() === term.toLowerCase());

	const handleOpenChange = (open: boolean) => {
		if (!open && !seen) markGlossSeen(term);
	};

	const label = children ?? term;

	if (!gloss || seen) {
		return (
			<span data-lore-term={term.toLowerCase()} className="italic">
				{label}
			</span>
		);
	}

	return (
		<TooltipProvider delayDuration={120}>
			<Tooltip onOpenChange={handleOpenChange}>
				<TooltipTrigger asChild>
					<span
						tabIndex={0}
						role="button"
						aria-label={`${term} — ${gloss.english}`}
						data-testid="lore-term"
						data-lore-term={term.toLowerCase()}
						className="cursor-help italic underline decoration-dotted decoration-1 underline-offset-[3px]"
					>
						{label}
					</span>
				</TooltipTrigger>
				<TooltipContent side="top" className="max-w-[280px] text-left leading-snug">
					<span className="font-semibold">{term}</span>
					<span className="opacity-70"> — {gloss.english}</span>
					<div className="mt-1 opacity-90">{gloss.gloss}</div>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
