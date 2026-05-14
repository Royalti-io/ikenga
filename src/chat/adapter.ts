/**
 * ChatAdapter interface — locked contract for any chat backend (CLI today,
 * SDK / Pencil deferred). Renderers (Thread / Composer / etc.) are completely
 * agnostic about which adapter is on the other end.
 *
 * v1 ships only `ClaudeCliAdapter`.
 */

import type { ChatEvent } from '@/lib/tauri-cmd';

export type { ChatEvent };

export interface AdapterCapabilities {
	toolCalls: boolean;
	artifacts: boolean;
	fileAttachments: boolean;
	imageInput: boolean;
	slashCommands: boolean;
	modelSwitching: boolean;
	/** ADR-011 phase 3: adapter exposes the discrete-effort control.
	 *  Composer renders the Effort pill as functional when true. */
	effortControl: boolean;
	streaming: boolean;
	promptCaching: boolean;
	agenticTools: boolean;
}

/** ADR-011 phase 3: 5-step extended-thinking effort control. Maps to
 *  claude CLI's `--thinking-budget-tokens` flag at spawn time. The
 *  session-level setting is stored on Rust-side `SessionOpts` and
 *  applied on next spawn (per-turn switching is deferred). */
export type ChatEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

/** Token budgets for each effort step. `off` maps to 0 (Rust side omits
 *  the flag entirely so claude defaults apply). */
export const EFFORT_TOKENS: Record<ChatEffort, number> = {
	off: 0,
	low: 1_000,
	medium: 4_000,
	high: 16_000,
	max: 32_000,
};

export interface ModelOption {
	id: string;
	label: string;
}

export interface Attachment {
	kind: 'file' | 'image';
	path: string;
	name: string;
}

export interface ChatInput {
	threadId: string;
	text: string;
	attachments?: Attachment[];
	slashCommand?: { name: string; args: string };
}

/** Persisted thread metadata. The full event log is held in the store +
 *  mirrored to SQLite / Claude's on-disk JSONL. */
export interface ChatThread {
	id: string;
	adapterId: string;
	title: string | null;
	cwd: string;
	model: string | null;
	/** Set once we know the real Claude Code session id. */
	claudeSessionId: string | null;
	/** When the adapter currently has a live PTY for this thread. Cleared when
	 *  the PTY exits or the app cold-starts. */
	ptyId: string | null;
	/** Phase 3 of projects-first-class: every thread is attached to a
	 *  project (nullable for legacy rows backfilled to NULL when the
	 *  parent project is archived). The /sessions list filters by the
	 *  active project's id; the session-detail page renders a move
	 *  popover that calls `chatThreadMove`. */
	projectId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface AdapterContext {
	/** Reserved — adapters can use this hook to read settings / secrets. */
	getConfig?: () => Promise<unknown>;
}

export interface ChatAdapter {
	readonly id: string;
	readonly label: string;
	readonly Icon: React.ComponentType<{ className?: string }>;
	readonly models: ModelOption[] | null;
	readonly capabilities: AdapterCapabilities;

	init(ctx: AdapterContext): Promise<void>;
	/** Attach the adapter's live subscription for a thread. Idempotent; safe
	 *  to call from a hook on every mount. v1 adapter has this; the interface
	 *  marks it optional so future adapters (SDK, Pencil) can declare it lazy.
	 *  Phase 3 (projects-first-class): `projectId` threads through to the
	 *  Rust ACP server via `_meta.projectId` so cwd resolution uses the
	 *  project's root_path. */
	attach?(threadId: string, cwd: string, projectId?: string | null): Promise<void>;
	/** Begin a turn. The store drains the iterable and updates UI state.
	 *  Returns a `streamId` usable for `cancel()`. */
	send(input: ChatInput): { streamId: string; iterable: AsyncIterable<ChatEvent> };
	cancel(streamId: string): Promise<void>;
	suspend(): Promise<void>;
	/** Only meaningful with multiple adapters; v1 is a no-op. */
	migrate(thread: ChatThread): Promise<void>;
	listSessions?(): Promise<unknown[]>;
	destroy(): Promise<void>;
}
