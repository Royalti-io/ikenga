// WP-18b R9 — the setup proposal card + confirm-write seam.
//
// This is the one genuinely net-new pixel surface of the setup-chat flow
// (plans/atelier-parity/designs/parity-setup-chat-impl.html §4-§6). Everything
// else in the flow is reused: the ActionBar button dispatches through the shared
// New-Session dialog, the conversation rides the unmodified dock chat, the
// interview walks `AskUserQuestion`. What did not exist is a renderer for the
// *proposal* — the inferred/interviewed `.atelier/<skill>/manifest.json` payload
// rendered as an approvable card — and the confirm-write that persists it.
//
// Honest-minimal Q1 (design §"Open questions"): the design's *preferred* path
// has the agent call an `atelier_write_instance` MCP tool through mcp-iyke,
// gated by the ACP permission ritual. That MCP tool does not exist yet (it is a
// T2 dependency; the tool names in the design are flagged placeholders). So this
// pass implements the *alternative* honest path: the card's "Confirm & localize"
// button calls the `atelier_file_write` Tauri command directly. The Rust command
// is generic (path-locked, atomic tmp+rename, traversal-guarded) but does not
// validate the envelope or stamp `configured_at` — per its contract that is the
// caller's job, done here. When the setup MCP surface lands, the same card can
// be wired to render the tool's pending input and defer the write to the
// permission ritual with no change to this presentational core.

import { useState } from 'react';

import { cn } from '@/components/ui/utils';
import { atelierFileWrite } from '@/lib/tauri-cmd';

/** A single proposed setting row. `value` is written verbatim into the
 *  envelope's `settings` object; `source` is provenance copy for the operator
 *  ("← default", "← README.md", "← Q2", "← kept from v1", "← NEW in v2 · …"). */
export interface ProposalField {
	key: string;
	value: unknown;
	source?: string;
	/** Migrate flow: a net-new v2 field — highlighted amber (§7). */
	isNew?: boolean;
}

export interface SetupProposal {
	/** Path segment under `.atelier/` — e.g. `'skill-mail'`. */
	skill: string;
	/** Envelope `skill` value written into the file — e.g. `'mail'` (§6 byte
	 *  example strips the `skill-` prefix). See the note in `SetupChatPanel`. */
	skillId: string;
	/** The template_version the confirm-write stamps. */
	templateVersion: number;
	/** Instance file name; defaults to `manifest.json`. */
	file?: string;
	fields: ProposalField[];
	/** Migrate flow: the prior on-disk version (renders "v1 → v2" in the head). */
	priorVersion?: number;
}

export interface SetupChatPanelProps {
	proposal: SetupProposal;
	/** Active project root — threaded to the Rust write command. `null` for the
	 *  seed Default project (the command rejects a null/empty root). */
	projectRoot: string | null;
	/** Fired with the written absolute path after a successful confirm-write. */
	onWritten?: (path: string) => void;
	/** Injectable for tests; defaults to the real Tauri command. */
	writeFile?: typeof atelierFileWrite;
}

type WriteState =
	| { status: 'idle' }
	| { status: 'writing' }
	| { status: 'written'; path: string }
	| { status: 'error'; message: string };

function formatValue(v: unknown): string {
	if (Array.isArray(v)) return v.map((x) => String(x)).join(' · ');
	if (v == null) return '';
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

/** Build the exact confirm-write bytes (§6). The envelope is the fixed contract
 *  the generic reader consumes at dispatch; `configured_at` is stamped host-side
 *  (here) at write time, never trusted from the proposal. Exported for the test
 *  so the byte shape is asserted directly. */
export function buildInstancePayload(proposal: SetupProposal, now: Date = new Date()): string {
	const settings: Record<string, unknown> = {};
	for (const f of proposal.fields) settings[f.key] = f.value;
	const payload = {
		skill: proposal.skillId,
		template_version: proposal.templateVersion,
		configured_at: now.toISOString(),
		settings,
	};
	return JSON.stringify(payload, null, 2);
}

export function SetupChatPanel({
	proposal,
	projectRoot,
	onWritten,
	writeFile = atelierFileWrite,
}: SetupChatPanelProps) {
	const [write, setWrite] = useState<WriteState>({ status: 'idle' });
	const file = proposal.file ?? 'manifest.json';
	const versionLabel =
		proposal.priorVersion != null
			? `v${proposal.priorVersion} → v${proposal.templateVersion}`
			: `v${proposal.templateVersion}`;

	async function confirm() {
		if (write.status === 'writing' || write.status === 'written') return;
		setWrite({ status: 'writing' });
		try {
			const body = buildInstancePayload(proposal);
			const path = await writeFile(projectRoot, proposal.skill, file, body);
			setWrite({ status: 'written', path });
			onWritten?.(path);
		} catch (e) {
			setWrite({ status: 'error', message: e instanceof Error ? e.message : String(e) });
		}
	}

	const written = write.status === 'written';

	return (
		<div
			className="overflow-hidden rounded-md border border-[var(--rule)] bg-[var(--bg-raised)]"
			aria-label="Setup proposal"
		>
			<div className="flex items-center gap-2 border-b border-[var(--rule-soft)] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
				<span className="truncate">
					{proposal.priorVersion != null ? 'migrate' : 'setup proposal'} · .atelier/
					{proposal.skill}/{file} · {versionLabel}
				</span>
			</div>

			<dl className="divide-y divide-[var(--rule-soft)]">
				{proposal.fields.map((f) => (
					<div
						key={f.key}
						className={cn(
							'grid grid-cols-[minmax(110px,140px)_1fr] items-baseline gap-2 px-3 py-1.5 text-[12.5px]',
							f.isNew && 'bg-[var(--kola-amber-soft)]'
						)}
					>
						<dt className="font-mono text-[11px] text-[var(--kola-amber)]">{f.key}</dt>
						<dd className="break-words text-[var(--fg,inherit)]">
							{formatValue(f.value)}
							{f.source && (
								<span className="ml-1 font-mono text-[11px] text-[var(--chip-carve)]">
									{f.source}
								</span>
							)}
						</dd>
					</div>
				))}
			</dl>

			<div className="flex flex-wrap items-center gap-2 border-t border-[var(--rule-soft)] px-3 py-2">
				<button
					type="button"
					onClick={confirm}
					disabled={write.status === 'writing' || written}
					className={cn(
						'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
						written
							? 'cursor-default border-[var(--verdigris)]/40 bg-[var(--verdigris)]/10 text-[var(--verdigris)]'
							: 'border-[var(--verdigris)] bg-[var(--verdigris)] text-[color:var(--bg-raised)] hover:brightness-110',
						write.status === 'writing' && 'opacity-60'
					)}
				>
					{written
						? '✓ written'
						: write.status === 'writing'
							? 'Writing…'
							: proposal.priorVersion != null
								? 'Confirm migrate'
								: 'Confirm & localize'}
				</button>
				{/* Per-row inline edit is deferred (design honesty note): edits happen
				    as plain chat turns in v1. Kept as a non-blocking affordance. */}
				<span className="font-mono text-[10px] text-[var(--chip-carve)]">
					edit any value as a chat reply
				</span>
			</div>

			{write.status === 'written' && (
				<p
					className="border-t border-[var(--rule-soft)] px-3 py-2 text-[11px] text-[var(--chip-carve)]"
					role="status"
				>
					Wrote{' '}
					<code className="rounded bg-[var(--rule-soft)] px-1 py-0.5 font-mono text-[11px]">
						{write.path}
					</code>{' '}
					· configured · v{proposal.templateVersion}
				</p>
			)}
			{write.status === 'error' && (
				<p
					className="border-t border-[var(--rule-soft)] px-3 py-2 text-[11px] text-[var(--oxblood)]"
					role="alert"
				>
					Write failed: {write.message}
				</p>
			)}
		</div>
	);
}
