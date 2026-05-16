// Lore module — vocabulary, microcopy, daily-address greetings, surface quotes.
// Source of truth lives in the sibling JSON files; this barrel adds types and
// a few derived helpers (time-of-day resolution, deterministic quote-of-the-day,
// gloss lookup). Locked vocabulary per design/shell/05-lore-and-nomenclature.md.
//
// Public re-exports — consume `quotes`, `glosses`, `greetings` from anywhere in
// the shell; do not import the JSON directly so future format changes only
// touch this file.

import quotesData from './quotes.json';
import glossesData from './glosses.json';
import greetingsData from './greetings.json';

// ───────────────────── types ─────────────────────

export interface Quote {
	id: string;
	text: string;
	source: string;
	work?: string;
	gloss?: string;
	fits: QuoteFit[];
}

export type QuoteFit =
	| 'welcome'
	| 'consent'
	| 'daily-address'
	| 'soft-fail'
	| 'team-upgrade'
	| 'multi-pane-empty'
	| 'empty-tasks'
	| 'outbox-empty';

export interface Gloss {
	term: string;
	english: string;
	gloss: string;
	tier: 1 | 2;
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface TimeOfDayGreeting {
	igbo: string;
	english: string;
	hoursStart: number;
	hoursEnd: number;
}

// ───────────────────── data ─────────────────────

export const quotes: Quote[] = quotesData.quotes as Quote[];
export const glosses: Gloss[] = glossesData.glosses as Gloss[];
export const greetings = greetingsData;

// ───────────────────── helpers ─────────────────────

export function partOfDay(now: Date = new Date()): PartOfDay {
	const h = now.getHours();
	if (h >= 5 && h < 12) return 'morning';
	if (h >= 12 && h < 17) return 'afternoon';
	if (h >= 17 && h < 21) return 'evening';
	return 'night';
}

export function dailyAddress(now: Date = new Date()): TimeOfDayGreeting {
	const part = partOfDay(now);
	return greetings.timeOfDay[part] as TimeOfDayGreeting;
}

// Same calendar day → same quote. Filter by `fit` if a context is provided.
export function quoteOfTheDay(now: Date = new Date(), fit?: QuoteFit): Quote {
	const pool = fit ? quotes.filter((q) => q.fits.includes(fit)) : quotes;
	if (!pool.length) return quotes[0];
	const yyyymmdd = Number(
		`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
	);
	return pool[yyyymmdd % pool.length];
}

export function glossFor(term: string): Gloss | undefined {
	const needle = term.toLowerCase();
	return glosses.find((g) => g.term.toLowerCase() === needle);
}
