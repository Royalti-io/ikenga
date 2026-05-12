// Activity-bar pin store — wraps the Tauri commands in a Zustand store and
// keeps the in-memory list in sync with SQLite. Mutations are optimistic:
// the local snapshot updates first, then the Rust call confirms (or errors
// and we re-hydrate from disk). Sections are kept in a separate slice so a
// pin update doesn't invalidate the sections list and vice versa.
//
// Section creation flow lives at the call sites — the store just exposes
// `createSection` and `addPin`. The "fuzzy match → prompt to create"
// dialog is UI; the host is the source of truth for what exists.

import { create } from 'zustand';
import {
	activityPinsAdd,
	activityPinsList,
	activityPinsRemove,
	activityPinsReorder,
	activitySectionsCreate,
	activitySectionsList,
	activitySectionsRemove,
	activitySectionsUpdate,
	type ActivityPin,
	type ActivityPinKind,
	type ActivitySection,
} from '@/lib/tauri-cmd';

export type Pin = ActivityPin;
export type Section = ActivitySection;
export type PinKind = ActivityPinKind;

/** Reserved ids — host-owned, cannot be created by users. Mirrors the
 *  validation on the Rust side. Exposed so UI can guide users away from
 *  those names before sending the create call. */
export const RESERVED_SECTION_IDS: readonly string[] = Object.freeze(['system', 'settings']);

export interface PinsState {
	pins: Pin[];
	sections: Section[];
	hydrated: boolean;
	loading: boolean;
	error: string | null;

	hydrate: () => Promise<void>;
	refresh: () => Promise<void>;

	/** Add a pin. Throws if `sectionId` references a missing section —
	 *  callers should create the section first via `createSection` (or
	 *  pass `null` for section-less pins). */
	addPin: (args: {
		kind: PinKind;
		target: string;
		label: string;
		iconLucide?: string | null;
		iconEmoji?: string | null;
		sectionId?: string | null;
	}) => Promise<Pin>;

	removePin: (id: string) => Promise<void>;

	/** Reorder pins within a single section. Pass empty string for the
	 *  section-less group. */
	reorderPins: (orderedIds: string[], sectionId: string) => Promise<void>;

	createSection: (args: {
		id: string;
		label: string;
		iconLucide?: string | null;
		iconEmoji?: string | null;
	}) => Promise<Section>;

	updateSection: (args: {
		id: string;
		label?: string;
		iconLucide?: string | null;
		iconEmoji?: string | null;
	}) => Promise<Section>;

	removeSection: (id: string) => Promise<void>;
}

/** Slugify a free-form label into a section id ([a-z0-9_-]). The host's
 *  `validate_section_id` is the source of truth for what's accepted; this
 *  helper just produces a candidate id from a label so callers don't have
 *  to invent their own normalization. */
export function slugifySectionId(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Fuzzy-match an existing section by id or label. Returns the matched
 *  section if any name contains, or is contained by, the candidate
 *  (case-insensitive). Used at pin time so the UI can ask "did you mean
 *  Finance?" before prompting to create a new section. */
export function fuzzyMatchSection(candidate: string, sections: readonly Section[]): Section | null {
	if (!candidate.trim()) return null;
	const slug = slugifySectionId(candidate);
	// 1. Exact id hit.
	const exact = sections.find((s) => s.id === slug);
	if (exact) return exact;
	// 2. Substring on label or id.
	const lc = candidate.toLowerCase();
	for (const s of sections) {
		const labelLc = s.label.toLowerCase();
		if (labelLc === lc) return s;
		if (labelLc.includes(lc) || lc.includes(labelLc)) return s;
		if (s.id.includes(slug) || slug.includes(s.id)) return s;
	}
	return null;
}

export const usePinsStore = create<PinsState>((set, get) => ({
	pins: [],
	sections: [],
	hydrated: false,
	loading: false,
	error: null,

	hydrate: async () => {
		if (get().hydrated || get().loading) return;
		set({ loading: true, error: null });
		try {
			const [pins, sections] = await Promise.all([activityPinsList(), activitySectionsList()]);
			set({ pins, sections, hydrated: true, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	refresh: async () => {
		set({ loading: true, error: null });
		try {
			const [pins, sections] = await Promise.all([activityPinsList(), activitySectionsList()]);
			set({ pins, sections, hydrated: true, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	addPin: async (args) => {
		const pin = await activityPinsAdd(args);
		set({ pins: [...get().pins, pin] });
		return pin;
	},

	removePin: async (id) => {
		// Optimistic remove; on error refresh from disk.
		const before = get().pins;
		set({ pins: before.filter((p) => p.id !== id) });
		try {
			await activityPinsRemove(id);
		} catch (e) {
			set({ pins: before, error: String(e) });
			throw e;
		}
	},

	reorderPins: async (orderedIds, sectionId) => {
		// Optimistic reorder of the slice belonging to this section.
		const before = get().pins;
		const inSection = (p: Pin) =>
			sectionId === '' ? p.sectionId === null : p.sectionId === sectionId;
		const others = before.filter((p) => !inSection(p));
		const idMap = new Map(before.map((p) => [p.id, p] as const));
		const reordered: Pin[] = [];
		orderedIds.forEach((id, idx) => {
			const p = idMap.get(id);
			if (p) {
				reordered.push({
					...p,
					sortOrder: idx,
					sectionId: sectionId === '' ? null : sectionId,
				});
			}
		});
		set({ pins: [...others, ...reordered] });
		try {
			await activityPinsReorder(orderedIds, sectionId);
		} catch (e) {
			set({ pins: before, error: String(e) });
			throw e;
		}
	},

	createSection: async (args) => {
		const section = await activitySectionsCreate(args);
		set({ sections: [...get().sections, section] });
		return section;
	},

	updateSection: async (args) => {
		const section = await activitySectionsUpdate(args);
		set({
			sections: get().sections.map((s) => (s.id === section.id ? section : s)),
		});
		return section;
	},

	removeSection: async (id) => {
		// Optimistic delete; the SQL ON DELETE SET NULL re-parents pins to NULL.
		const before = { sections: get().sections, pins: get().pins };
		set({
			sections: before.sections.filter((s) => s.id !== id),
			pins: before.pins.map((p) => (p.sectionId === id ? { ...p, sectionId: null } : p)),
		});
		try {
			await activitySectionsRemove(id);
		} catch (e) {
			set({
				sections: before.sections,
				pins: before.pins,
				error: String(e),
			});
			throw e;
		}
	},
}));

/** Selector hook returning pins grouped by section, plus a loose group for
 *  section-less pins. Consumers iterate `sections` to render headers in
 *  user order, then look up `pinsBySection.get(section.id)`. */
export function useActivityBarPins() {
	const pins = usePinsStore((s) => s.pins);
	const sections = usePinsStore((s) => s.sections);
	const hydrated = usePinsStore((s) => s.hydrated);

	const sortedSections = [...sections].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
	);
	const sortedPins = [...pins].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
	);
	const pinsBySection = new Map<string, Pin[]>();
	const sectionLessPins: Pin[] = [];
	for (const pin of sortedPins) {
		if (pin.sectionId === null) {
			sectionLessPins.push(pin);
		} else {
			const list = pinsBySection.get(pin.sectionId) ?? [];
			list.push(pin);
			pinsBySection.set(pin.sectionId, list);
		}
	}
	return {
		sections: sortedSections,
		pinsBySection,
		sectionLessPins,
		hydrated,
	};
}
