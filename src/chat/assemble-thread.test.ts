import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@/lib/tauri-cmd';
import { assembleThread } from './hooks';
import type { PersistedMessage } from './persist';

type UserTurn = Awaited<ReturnType<typeof import('./persist').loadUserTurns>>[number];

function userTurn(text: string, sequence: number, createdAt: number): UserTurn {
	return { id: `ut:${sequence}`, threadId: 't', text, sequence, createdAt };
}

function msg(events: ChatEvent[], createdAt: number): PersistedMessage {
	return { id: `m:${createdAt}`, role: 'assistant', events, createdAt };
}

const textEv = (delta: string, messageId: string): ChatEvent => ({
	kind: 'text',
	delta,
	messageId,
});

describe('assembleThread', () => {
	it('legacy session (no persisted messages): renders from JSONL with user turns spliced in', () => {
		const jsonl: ChatEvent[] = [
			textEv('hello from claude', 'm1'),
			{ kind: 'done', stopReason: 'end_turn' },
		];
		const out = assembleThread(jsonl, [userTurn('hi', 0, 100)], []);
		expect(out.map((e) => e.kind)).toEqual(['user_turn', 'text', 'done']);
		expect(out.filter((e) => e.kind === 'text')).toHaveLength(1);
	});

	it('JSONL has the same content already persisted: no double-render', () => {
		const jsonl: ChatEvent[] = [textEv('answer', 'm1'), { kind: 'done', stopReason: 'end_turn' }];
		const messages = [msg([textEv('answer', 'm1')], 150)];
		const out = assembleThread(jsonl, [userTurn('q', 0, 100)], messages);
		// The persisted turn dedups against JSONL by messageId — exactly one text.
		expect(out.filter((e) => e.kind === 'text')).toHaveLength(1);
		expect(out.map((e) => e.kind)).toEqual(['user_turn', 'text', 'done']);
	});

	it('JSONL missing the last turn: persisted turn is recovered at the end', () => {
		// JSONL flushed turn 1 but not turn 2 (aborted before transcript write).
		const jsonl: ChatEvent[] = [
			textEv('first answer', 'm1'),
			{ kind: 'done', stopReason: 'end_turn' },
		];
		const messages = [
			msg([textEv('first answer', 'm1')], 150),
			msg([textEv('second answer', 'm2')], 350),
		];
		const out = assembleThread(jsonl, [userTurn('q1', 0, 100), userTurn('q2', 1, 300)], messages);
		const texts = out.filter((e): e is Extract<ChatEvent, { kind: 'text' }> => e.kind === 'text');
		expect(texts.map((t) => t.delta)).toEqual(['first answer', 'second answer']);
	});

	it('JSONL empty (missing session id / transcript-less engine): reconstruct from SQLite by timestamp', () => {
		const messages = [msg([textEv('a1', 'm1')], 150), msg([textEv('a2', 'm2')], 350)];
		const out = assembleThread([], [userTurn('u1', 0, 100), userTurn('u2', 1, 300)], messages);
		expect(out.map((e) => e.kind)).toEqual(['user_turn', 'text', 'user_turn', 'text']);
		const seq = out.map((e) =>
			e.kind === 'user_turn' ? e.text : e.kind === 'text' ? e.delta : e.kind
		);
		expect(seq).toEqual(['u1', 'a1', 'u2', 'a2']);
	});

	it('nothing persisted and JSONL empty: just the user turns', () => {
		const out = assembleThread([], [userTurn('only-user', 0, 100)], []);
		expect(out.map((e) => e.kind)).toEqual(['user_turn']);
	});
});
