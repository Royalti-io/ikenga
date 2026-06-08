/* Render + a11y + interaction tests for <ApproveGatePanel />.
 * Covers the queue render, the accessible-name contract (the 5 quality-gate blockers),
 * J/K row navigation, ⌘S edit, the 10s undo window, and the reject/send-to-chat seams. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApproveGatePanel } from './approve-gate-panel';
import { APPROVE_GATE_FIXTURES } from './approve-gate-panel.fixtures';

afterEach(cleanup);

function setup(
	over: Partial<
		Record<
			'onApprove' | 'onReject' | 'onSendToChat' | 'onContinueSession' | 'onEdit',
			ReturnType<typeof vi.fn>
		>
	> = {}
) {
	const h = {
		onApprove: vi.fn(),
		onReject: vi.fn(),
		onSendToChat: vi.fn(),
		onContinueSession: vi.fn(),
		onEdit: vi.fn(),
		...over,
	};
	render(<ApproveGatePanel drafts={APPROVE_GATE_FIXTURES} {...h} />);
	return h;
}

const subjectValue = () => (screen.getByLabelText('Email subject') as HTMLInputElement).value;

describe('ApproveGatePanel', () => {
	it('renders the draft queue from fixtures', () => {
		setup();
		expect(screen.getByText('Approvals')).toBeTruthy();
		expect(screen.getAllByText('Valentim de Carvalho').length).toBeGreaterThan(0);
		expect(screen.getByText('Hannah Ekudo')).toBeTruthy();
		expect(screen.getByText('L5 Winback · 388 recipients')).toBeTruthy();
		expect(screen.getByText(/1 overdue/)).toBeTruthy();
	});

	it('exposes accessible names on rows, checkboxes, fields, and the divider (a11y blockers)', () => {
		setup();
		// blocker 3 — editable fields have programmatic labels
		expect(screen.getByLabelText('Email subject')).toBeTruthy();
		expect(screen.getByLabelText('Email body')).toBeTruthy();
		// rows + checkboxes
		expect(
			screen.getByRole('button', { name: /Valentim de Carvalho – Re: Catalog import/ })
		).toBeTruthy();
		expect(
			screen.getByRole('checkbox', { name: 'Select Valentim de Carvalho draft' })
		).toBeTruthy();
		// primary CTA carries the keyboard shortcut
		expect(
			screen.getByRole('button', { name: /Approve & Send/ }).getAttribute('aria-keyshortcuts')
		).toBe('Meta+Enter');
		// divider is an operable separator
		expect(screen.getByRole('separator', { name: 'Resize draft list' })).toBeTruthy();
		// the section landmark
		expect(screen.getByLabelText('Draft approvals')).toBeTruthy();
	});

	it('J/K navigates the queue in display order (blocker 5)', () => {
		setup();
		const surface = screen.getByLabelText('Draft approvals');
		// initial selection = Valentim (Today). Display order: Overdue(Hannah) → Today(Valentim, LinkedIn) → This week(L5).
		expect(subjectValue()).toMatch(/Re: Catalog import/);
		fireEvent.keyDown(surface, { key: 'j' }); // next (j = down, vim) → LinkedIn social
		expect(subjectValue()).toMatch(/Ship note/);
		fireEvent.keyDown(surface, { key: 'k' }); // previous (k = up, vim) → Valentim
		expect(subjectValue()).toMatch(/Re: Catalog import/);
	});

	it('⌘S persists an edit and shows the saved indicator + EDITED chip', () => {
		const h = setup();
		fireEvent.change(screen.getByLabelText('Email subject'), {
			target: { value: 'Re: Catalog import — updated' },
		});
		fireEvent.keyDown(screen.getByLabelText('Email body'), { key: 's', metaKey: true });
		expect(h.onEdit).toHaveBeenCalled();
		expect(screen.getByText(/Saved/)).toBeTruthy();
	});

	it('Approve & Send opens the undo window; Undo cancels before commit', () => {
		const h = setup();
		fireEvent.click(screen.getByRole('button', { name: /Approve & Send/ }));
		// the Undo button exists only inside the undo toast → its presence proves the window opened
		expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
		expect(h.onApprove).not.toHaveBeenCalled();
	});

	it('commits onApprove after the 10s undo window elapses', () => {
		vi.useFakeTimers();
		try {
			const h = setup();
			fireEvent.click(screen.getByRole('button', { name: /Approve & Send/ }));
			for (let i = 0; i < 12; i++) {
				act(() => {
					vi.advanceTimersByTime(1000);
				});
			}
			expect(h.onApprove).toHaveBeenCalledWith('4f8e2');
		} finally {
			vi.useRealTimers();
		}
	});

	it('Reject fires onReject and removes the row', () => {
		const h = setup();
		fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
		expect(h.onReject).toHaveBeenCalledWith('4f8e2');
		expect(screen.queryByText('Valentim de Carvalho')).toBeNull();
	});

	it('Send to chat fires its seam', () => {
		const h = setup();
		fireEvent.click(screen.getByRole('button', { name: /Send to chat/ }));
		expect(h.onSendToChat).toHaveBeenCalledWith('4f8e2');
	});

	it('checking rows reveals the bulk bar and Approve all commits the checked set', () => {
		const h = setup();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Select Hannah Ekudo draft' }));
		fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
		expect(h.onApprove).toHaveBeenCalledWith('rs-91c2');
	});
});
