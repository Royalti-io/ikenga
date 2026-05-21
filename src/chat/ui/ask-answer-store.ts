/**
 * Resolution state for inline `AskUserQuestion` tool calls, keyed by
 * `tool_use` id.
 *
 * Why a store instead of component state: the answering `tool_result` is
 * written to claude's stdin and is never echoed back as a stream event, so
 * `pair.result` stays `null` even after we answer. If the "answered" flag
 * lived in the renderer's `useState`, switching chat tabs / remounting the
 * transcript would reset it and resurface the still-`pending` form — letting
 * the user submit a *second* `tool_result` for a question claude already
 * received. Keying the resolution by the immutable `tool_use` id makes it
 * survive remounts for the app session (not persisted across reloads, which
 * is fine — a reload re-reads the JSONL and the turn has moved on).
 */

import { create } from 'zustand';

export interface AskResolution {
	/** Selected answers (question text → value). Absent when cancelled. */
	answers?: Record<string, string | string[]>;
	/** True when the user dismissed the question without answering. */
	cancelled: boolean;
}

interface AskAnswerStore {
	resolved: Record<string, AskResolution>;
	markAnswered: (toolUseId: string, answers: Record<string, string | string[]>) => void;
	markCancelled: (toolUseId: string) => void;
	/** Roll back an optimistic mark when the `sessionToolResult` round-trip
	 *  fails, so the user can retry. */
	clear: (toolUseId: string) => void;
}

export const useAskAnswerStore = create<AskAnswerStore>((set) => ({
	resolved: {},
	markAnswered: (toolUseId, answers) =>
		set((s) => ({
			resolved: { ...s.resolved, [toolUseId]: { answers, cancelled: false } },
		})),
	markCancelled: (toolUseId) =>
		set((s) => ({ resolved: { ...s.resolved, [toolUseId]: { cancelled: true } } })),
	clear: (toolUseId) =>
		set((s) => {
			if (!(toolUseId in s.resolved)) return s;
			const next = { ...s.resolved };
			delete next[toolUseId];
			return { resolved: next };
		}),
}));
