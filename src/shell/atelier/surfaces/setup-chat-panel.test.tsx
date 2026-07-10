/* Render + confirm-write tests for the setup proposal card (WP-18b R9).
 * Covers: the proposal renders its fields + provenance, "Confirm & localize"
 * builds the exact §6 envelope and calls the injected write command, the written
 * state renders the path, a failed write surfaces the error, and the migrate
 * variant labels the head + confirm button. Plus a pure buildInstancePayload
 * byte-shape assertion. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildInstancePayload,
	SetupChatPanel,
	type SetupProposal,
} from './setup-chat-panel';

afterEach(cleanup);

const MAIL_PROPOSAL: SetupProposal = {
	skill: 'skill-mail',
	skillId: 'mail',
	templateVersion: 1,
	fields: [
		{ key: 'inbox_label', value: 'INBOX', source: '← default' },
		{
			key: 'triage_buckets',
			value: ['reply-now', 'delegate', 'archive'],
			source: '← README.md workflow section',
		},
		{ key: 'default_signature', value: '— sent from Ikenga', source: '← default' },
	],
};

describe('SetupChatPanel', () => {
	it('renders the proposal fields, values, and provenance', () => {
		render(<SetupChatPanel proposal={MAIL_PROPOSAL} projectRoot="/labels/acme" />);
		expect(screen.getByText('inbox_label')).toBeTruthy();
		expect(screen.getByText(/reply-now · delegate · archive/)).toBeTruthy();
		expect(screen.getByText('← README.md workflow section')).toBeTruthy();
		expect(screen.getByText(/\.atelier\/skill-mail\/manifest\.json · v1/)).toBeTruthy();
		expect(screen.getByRole('button', { name: /Confirm & localize/ })).toBeTruthy();
	});

	it('confirm-write calls the write command with the exact §6 envelope', async () => {
		const writeFile = vi.fn().mockResolvedValue('/labels/acme/.atelier/skill-mail/manifest.json');
		const onWritten = vi.fn();
		render(
			<SetupChatPanel
				proposal={MAIL_PROPOSAL}
				projectRoot="/labels/acme"
				writeFile={writeFile}
				onWritten={onWritten}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /Confirm & localize/ }));

		await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
		const [root, skill, file, body] = writeFile.mock.calls[0];
		expect(root).toBe('/labels/acme');
		expect(skill).toBe('skill-mail');
		expect(file).toBe('manifest.json');
		const parsed = JSON.parse(body as string);
		expect(parsed.skill).toBe('mail');
		expect(parsed.template_version).toBe(1);
		expect(parsed.settings).toEqual({
			inbox_label: 'INBOX',
			triage_buckets: ['reply-now', 'delegate', 'archive'],
			default_signature: '— sent from Ikenga',
		});
		expect(typeof parsed.configured_at).toBe('string');
		expect(Number.isNaN(Date.parse(parsed.configured_at))).toBe(false);

		await waitFor(() => expect(screen.getByText(/configured · v1/)).toBeTruthy());
		expect(onWritten).toHaveBeenCalledWith('/labels/acme/.atelier/skill-mail/manifest.json');
		// The button disables after a successful write (no double-commit).
		expect((screen.getByText('✓ written').closest('button') as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it('surfaces a write failure without claiming success', async () => {
		const writeFile = vi.fn().mockRejectedValue(new Error('no project root configured'));
		render(
			<SetupChatPanel proposal={MAIL_PROPOSAL} projectRoot={null} writeFile={writeFile} />
		);
		fireEvent.click(screen.getByRole('button', { name: /Confirm & localize/ }));
		await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
		expect(screen.getByRole('alert').textContent).toContain('no project root configured');
		// Still re-attemptable — not stuck in a written state.
		expect(screen.queryByText('✓ written')).toBeNull();
	});

	it('migrate variant labels the head and confirm button and highlights new fields', () => {
		const migrate: SetupProposal = {
			...MAIL_PROPOSAL,
			templateVersion: 2,
			priorVersion: 1,
			fields: [
				...MAIL_PROPOSAL.fields,
				{ key: 'vip_senders', value: ['a@x', 'b@y'], source: '← NEW in v2', isNew: true },
			],
		};
		render(<SetupChatPanel proposal={migrate} projectRoot="/labels/acme" />);
		expect(screen.getByText(/migrate · .atelier\/skill-mail\/manifest\.json · v1 → v2/)).toBeTruthy();
		expect(screen.getByRole('button', { name: /Confirm migrate/ })).toBeTruthy();
		expect(screen.getByText('vip_senders')).toBeTruthy();
	});
});

describe('buildInstancePayload', () => {
	it('stamps configured_at host-side and shapes the fixed envelope', () => {
		const now = new Date('2026-07-03T14:22:00Z');
		const body = buildInstancePayload(MAIL_PROPOSAL, now);
		expect(JSON.parse(body)).toEqual({
			skill: 'mail',
			template_version: 1,
			configured_at: '2026-07-03T14:22:00.000Z',
			settings: {
				inbox_label: 'INBOX',
				triage_buckets: ['reply-now', 'delegate', 'archive'],
				default_signature: '— sent from Ikenga',
			},
		});
	});
});
