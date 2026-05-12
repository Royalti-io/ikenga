import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks for the tauri-cmd module — vitest's vi.mock is hoisted, so
// we expose our state via the factory return value and reach into it via
// the `mocked` import below.
vi.mock('@/lib/tauri-cmd', () => {
	const state = {
		pins: [] as Array<Record<string, unknown>>,
		sections: [] as Array<Record<string, unknown>>,
		nextId: 1,
	};
	return {
		activityPinsList: vi.fn(async () => state.pins.slice()),
		activitySectionsList: vi.fn(async () => state.sections.slice()),
		activityPinsAdd: vi.fn(async (args: Record<string, unknown>) => {
			// Validate section exists when provided (mirrors the Rust check so
			// store tests can exercise the missing-section path).
			if (args.sectionId && !state.sections.some((s) => s.id === args.sectionId)) {
				throw new Error(`section '${args.sectionId}' does not exist`);
			}
			const sortOrder = state.pins.filter((p) =>
				(args.sectionId ?? null) === null ? p.sectionId === null : p.sectionId === args.sectionId
			).length;
			const pin = {
				id: `pin-${state.nextId++}`,
				kind: args.kind,
				target: args.target,
				label: args.label,
				iconLucide: args.iconLucide ?? null,
				iconEmoji: args.iconEmoji ?? null,
				sectionId: args.sectionId ?? null,
				sortOrder,
				createdAt: '2026-05-10T00:00:00Z',
			};
			state.pins.push(pin);
			return pin;
		}),
		activityPinsRemove: vi.fn(async (id: string) => {
			state.pins = state.pins.filter((p) => p.id !== id);
		}),
		activityPinsReorder: vi.fn(async (orderedIds: string[], sectionId: string) => {
			const targetSection = sectionId === '' ? null : sectionId;
			orderedIds.forEach((id, idx) => {
				const p = state.pins.find((p) => p.id === id);
				if (p) {
					p.sortOrder = idx;
					p.sectionId = targetSection;
				}
			});
		}),
		activitySectionsCreate: vi.fn(async (args: Record<string, unknown>) => {
			if (args.id === 'system' || args.id === 'settings') {
				throw new Error(`'${args.id}' is a reserved section id`);
			}
			const section = {
				id: args.id,
				label: args.label,
				iconLucide: args.iconLucide ?? null,
				iconEmoji: args.iconEmoji ?? null,
				sortOrder: state.sections.length,
				createdAt: '2026-05-10T00:00:00Z',
			};
			state.sections.push(section);
			return section;
		}),
		activitySectionsUpdate: vi.fn(async (args: Record<string, unknown>) => {
			const s = state.sections.find((s) => s.id === args.id);
			if (!s) throw new Error('section not found');
			if (args.label !== undefined) s.label = args.label;
			if (Object.hasOwn(args, 'iconLucide')) {
				s.iconLucide = args.iconLucide ?? null;
			}
			if (Object.hasOwn(args, 'iconEmoji')) {
				s.iconEmoji = args.iconEmoji ?? null;
			}
			return { ...s };
		}),
		activitySectionsRemove: vi.fn(async (id: string) => {
			state.sections = state.sections.filter((s) => s.id !== id);
			// SQL ON DELETE SET NULL — re-parent pins.
			for (const p of state.pins) {
				if (p.sectionId === id) p.sectionId = null;
			}
		}),
		__resetMockState: () => {
			state.pins = [];
			state.sections = [];
			state.nextId = 1;
		},
	};
});

import * as cmd from '@/lib/tauri-cmd';
import { fuzzyMatchSection, slugifySectionId, usePinsStore } from './pins-store';

const resetMockState = (cmd as unknown as { __resetMockState: () => void }).__resetMockState;

beforeEach(async () => {
	resetMockState();
	// Reset the store between tests (Zustand keeps a singleton).
	usePinsStore.setState({
		pins: [],
		sections: [],
		hydrated: false,
		loading: false,
		error: null,
	});
});

describe('slugifySectionId', () => {
	it('lowercases and replaces non-allowed characters', () => {
		expect(slugifySectionId('Finance')).toBe('finance');
		expect(slugifySectionId('My Section')).toBe('my-section');
		expect(slugifySectionId('  weird///chars!! ')).toBe('weird-chars');
	});

	it('strips leading and trailing dashes', () => {
		expect(slugifySectionId('--foo--')).toBe('foo');
	});
});

describe('fuzzyMatchSection', () => {
	const sections = [
		{
			id: 'finance',
			label: 'Finance',
			iconLucide: null,
			iconEmoji: null,
			sortOrder: 0,
			createdAt: 'x',
		},
		{
			id: 'design-tokens',
			label: 'Design Tokens',
			iconLucide: null,
			iconEmoji: null,
			sortOrder: 1,
			createdAt: 'x',
		},
	];

	it('matches on exact id', () => {
		expect(fuzzyMatchSection('finance', sections)?.id).toBe('finance');
	});

	it('matches on case-insensitive label', () => {
		expect(fuzzyMatchSection('FINANCE', sections)?.id).toBe('finance');
	});

	it('matches on substring of label', () => {
		expect(fuzzyMatchSection('design', sections)?.id).toBe('design-tokens');
	});

	it('returns null on miss', () => {
		expect(fuzzyMatchSection('outbound', sections)).toBeNull();
	});

	it('returns null on empty input', () => {
		expect(fuzzyMatchSection('   ', sections)).toBeNull();
	});
});

describe('pins store — section creation flow', () => {
	it('hydrates from empty disk', async () => {
		await usePinsStore.getState().hydrate();
		expect(usePinsStore.getState().pins).toEqual([]);
		expect(usePinsStore.getState().sections).toEqual([]);
		expect(usePinsStore.getState().hydrated).toBe(true);
	});

	it('creates a section, then pins to it', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		const section = await store.createSection({
			id: 'finance',
			label: 'Finance',
			iconLucide: 'wallet',
		});
		expect(section.id).toBe('finance');
		expect(usePinsStore.getState().sections).toHaveLength(1);

		const pin = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/finance/expenses',
			label: 'Expenses',
			sectionId: 'finance',
		});
		expect(pin.sectionId).toBe('finance');
		expect(pin.sortOrder).toBe(0);
		expect(usePinsStore.getState().pins).toHaveLength(1);
	});

	it('rejects pinning to a non-existent section', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await expect(
			usePinsStore.getState().addPin({
				kind: 'route',
				target: '/x',
				label: 'X',
				sectionId: 'nope',
			})
		).rejects.toThrow();
	});

	it('rejects creating a section with a reserved id', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await expect(store.createSection({ id: 'system', label: 'System' })).rejects.toThrow();
		await expect(store.createSection({ id: 'settings', label: 'Settings' })).rejects.toThrow();
	});
});

describe('pins store — reorder', () => {
	it('reorders pins within a section and persists sort_order', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await store.createSection({ id: 'finance', label: 'Finance' });
		const a = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/a',
			label: 'A',
			sectionId: 'finance',
		});
		const b = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/b',
			label: 'B',
			sectionId: 'finance',
		});
		const c = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/c',
			label: 'C',
			sectionId: 'finance',
		});

		// Reverse the order: c, b, a.
		await usePinsStore.getState().reorderPins([c.id, b.id, a.id], 'finance');

		const after = usePinsStore.getState().pins;
		const orderById = new Map(after.map((p) => [p.id, p.sortOrder] as const));
		expect(orderById.get(c.id)).toBe(0);
		expect(orderById.get(b.id)).toBe(1);
		expect(orderById.get(a.id)).toBe(2);
	});

	it('moves a pin into a different section via reorder', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await store.createSection({ id: 'finance', label: 'Finance' });
		await store.createSection({ id: 'ops', label: 'Ops' });
		const a = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/a',
			label: 'A',
			sectionId: 'finance',
		});
		// Reorder into 'ops' moves the pin's sectionId.
		await usePinsStore.getState().reorderPins([a.id], 'ops');
		const moved = usePinsStore.getState().pins.find((p) => p.id === a.id);
		expect(moved?.sectionId).toBe('ops');
		expect(moved?.sortOrder).toBe(0);
	});

	it('reverts state on Rust error', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await store.createSection({ id: 'finance', label: 'Finance' });
		const a = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/a',
			label: 'A',
			sectionId: 'finance',
		});

		const reorderMock = cmd.activityPinsReorder as ReturnType<typeof vi.fn>;
		reorderMock.mockImplementationOnce(async () => {
			throw new Error('boom');
		});

		await expect(usePinsStore.getState().reorderPins([a.id], 'finance')).rejects.toThrow('boom');
		// State should be back to original (sortOrder still 0, sectionId
		// unchanged).
		const restored = usePinsStore.getState().pins.find((p) => p.id === a.id);
		expect(restored?.sectionId).toBe('finance');
		expect(restored?.sortOrder).toBe(0);
	});
});

describe('pins store — section removal re-parents pins', () => {
	it('sets sectionId to null on pins when their section is removed', async () => {
		const store = usePinsStore.getState();
		await store.hydrate();
		await store.createSection({ id: 'finance', label: 'Finance' });
		const a = await usePinsStore.getState().addPin({
			kind: 'route',
			target: '/a',
			label: 'A',
			sectionId: 'finance',
		});
		await usePinsStore.getState().removeSection('finance');
		const after = usePinsStore.getState().pins.find((p) => p.id === a.id);
		expect(after?.sectionId).toBeNull();
		expect(usePinsStore.getState().sections).toHaveLength(0);
	});
});
