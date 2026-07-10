/* WP-18b — the pure setup dispatch + state logic. Covers name-keyed
 * dispatchability, the synthesized seed prompt, instance-state derivation, and
 * the proposal-input adapter. No DOM / Tauri — pure functions only. */

import { describe, expect, it } from 'vitest';
import type { SkillAction } from '@/lib/tauri-cmd';
import { buildSetupPrompt, isDispatchable, isSetupAction } from './action-runner';
import { deriveSetupState, setupButtonLabel } from './use-setup-state';
import {
	deriveSkillIdentity,
	isSetupProposeTool,
	proposalFromInput,
} from '@/chat/ui/tool-renderers/setup-proposal';

function action(over: Partial<SkillAction>): SkillAction {
	return {
		pkgId: 'com.ikenga.mail',
		skill: 'skill-mail',
		verb: 'triage-inbox',
		name: 'triage-inbox',
		uxMode: 'confirm',
		...over,
	};
}

describe('isSetupAction / isDispatchable', () => {
	it('recognizes the setup action by name or verb', () => {
		expect(isSetupAction(action({ name: 'setup', verb: 'setup' }))).toBe(true);
		expect(isSetupAction(action({ name: 'setup', verb: 'other' }))).toBe(true);
		expect(isSetupAction(action({ name: 'triage-inbox' }))).toBe(false);
	});

	it('enables setup regardless of its streaming ux_mode', () => {
		expect(isDispatchable(action({ name: 'setup', verb: 'setup', uxMode: 'streaming' }))).toBe(true);
	});

	it('keeps other streaming actions disabled', () => {
		expect(isDispatchable(action({ name: 'briefing', uxMode: 'streaming' }))).toBe(false);
	});

	it('still dispatches confirm and approve', () => {
		expect(isDispatchable(action({ uxMode: 'confirm' }))).toBe(true);
		expect(isDispatchable(action({ uxMode: 'approve' }))).toBe(true);
	});
});

describe('buildSetupPrompt', () => {
	it('prefers the author promptTemplate verbatim', () => {
		const p = buildSetupPrompt(
			action({ name: 'setup', verb: 'setup', promptTemplate: 'Custom setup instructions.' }),
			false
		);
		expect(p).toBe('Custom setup instructions.');
	});

	it('synthesizes an ai-infer prompt from the setup spec', () => {
		const p = buildSetupPrompt(
			action({
				name: 'setup',
				verb: 'setup',
				setup: { mode: 'ai_infer', templateVersion: 1, inferSources: ['package.json', 'README.md'] },
			}),
			false
		);
		expect(p).toContain('mode: ai_infer, template_version: 1');
		expect(p).toContain('package.json, README.md');
		expect(p).toContain('.atelier/skill-mail/manifest.json');
	});

	it('forces interview mode on the modifier flag', () => {
		const p = buildSetupPrompt(
			action({ name: 'setup', verb: 'setup', setup: { mode: 'ai_infer', templateVersion: 2 } }),
			true
		);
		expect(p).toContain('mode: interview, template_version: 2');
		expect(p).toContain('setup.interview_questions');
	});
});

describe('deriveSetupState / setupButtonLabel', () => {
	it('none when the instance file is absent', () => {
		expect(deriveSetupState(null, 1)).toEqual({ status: 'none' });
		expect(setupButtonLabel(deriveSetupState(null, 1))).toBe('Set up');
	});

	it('none when the file cannot be parsed or has no version', () => {
		expect(deriveSetupState('not json', 1)).toEqual({ status: 'none' });
		expect(deriveSetupState('{"settings":{}}', 1)).toEqual({ status: 'none' });
	});

	it('configured when versions match', () => {
		const s = deriveSetupState('{"template_version":2}', 2);
		expect(s).toEqual({ status: 'configured', version: 2 });
		expect(setupButtonLabel(s)).toBe('Re-run setup');
	});

	it('drift when the file version trails the declared latest', () => {
		const s = deriveSetupState('{"template_version":1}', 2);
		expect(s).toEqual({ status: 'drift', version: 1, latest: 2 });
		expect(setupButtonLabel(s)).toBe('Migrate v1→v2');
	});

	it('configured (not drift) when latest is unknown', () => {
		expect(deriveSetupState('{"template_version":3}', undefined)).toEqual({
			status: 'configured',
			version: 3,
		});
	});
});

describe('setup proposal adapter', () => {
	it('derives the path segment and envelope id from either input form', () => {
		expect(deriveSkillIdentity('mail')).toEqual({ segment: 'skill-mail', id: 'mail' });
		expect(deriveSkillIdentity('skill-mail')).toEqual({ segment: 'skill-mail', id: 'mail' });
	});

	it('matches placeholder + trailing-token tool names', () => {
		expect(isSetupProposeTool('atelier_setup.propose')).toBe(true);
		expect(isSetupProposeTool('atelier_write_instance')).toBe(true);
		expect(isSetupProposeTool('mcp__iyke__atelier_setup_propose')).toBe(true);
		expect(isSetupProposeTool('Read')).toBe(false);
	});

	it('maps a propose input into a proposal, carrying provenance and new-field flags', () => {
		const proposal = proposalFromInput({
			skill: 'mail',
			template_version: 2,
			prior_version: 1,
			settings: { inbox_label: 'INBOX', vip_senders: ['a@x'] },
			sources: { inbox_label: '← default' },
			new_fields: ['vip_senders'],
		});
		expect(proposal).not.toBeNull();
		expect(proposal?.skill).toBe('skill-mail');
		expect(proposal?.skillId).toBe('mail');
		expect(proposal?.templateVersion).toBe(2);
		expect(proposal?.priorVersion).toBe(1);
		expect(proposal?.fields.find((f) => f.key === 'vip_senders')?.isNew).toBe(true);
		expect(proposal?.fields.find((f) => f.key === 'inbox_label')?.source).toBe('← default');
	});

	it('returns null for malformed input', () => {
		expect(proposalFromInput(null)).toBeNull();
		expect(proposalFromInput({ settings: {} })).toBeNull();
		expect(proposalFromInput('string')).toBeNull();
	});
});
