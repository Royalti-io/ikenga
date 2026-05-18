// LoreTerm — gloss tooltip on first contact, plain text after acknowledgement.
//
// We exercise the surface decision (tooltip trigger vs plain text) and the
// markGlossSeen side-effect; Radix Tooltip's open-state animation is its own
// concern and isn't exercised here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { createDefaultOnboardingState, useShellStore } from '@/lib/shell/shell-store';

import { LoreTerm } from './lore-term';

beforeEach(() => {
	useShellStore.setState({ onboarding: createDefaultOnboardingState() });
});

afterEach(() => {
	cleanup();
});

describe('LoreTerm', () => {
	it('renders the term wrapped in a tooltip trigger on first contact', () => {
		render(<LoreTerm term="Chi">Chi</LoreTerm>);
		const trigger = screen.getByTestId('lore-term');
		expect(trigger).toBeTruthy();
		expect(trigger.textContent).toBe('Chi');
		expect(trigger.getAttribute('aria-label')).toContain('Chi');
	});

	it('renders plain text once the gloss is acknowledged', () => {
		useShellStore.getState().markGlossSeen('Chi');
		render(<LoreTerm term="Chi">Chi</LoreTerm>);
		expect(screen.queryByTestId('lore-term')).toBeNull();
		// The label still renders as text inside a plain span.
		const span = document.querySelector('[data-lore-term="chi"]');
		expect(span?.textContent).toBe('Chi');
	});

	it('falls back to plain text for unknown terms', () => {
		render(<LoreTerm term="NotInGlosses">NotInGlosses</LoreTerm>);
		expect(screen.queryByTestId('lore-term')).toBeNull();
	});

	it('markGlossSeen is idempotent', () => {
		const { markGlossSeen } = useShellStore.getState();
		markGlossSeen('Chi');
		markGlossSeen('Chi');
		markGlossSeen('chi'); // case-insensitive
		expect(useShellStore.getState().onboarding.loreGlossSeen).toEqual(['Chi']);
	});
});
