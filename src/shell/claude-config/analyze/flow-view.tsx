// Orchestration flow (Phase 4 · D-03 "Flow" view) — the Ngwa Analyze
// `surface=flow`. Shows the *procedural* step-sequence inside one command /
// agent / skill body: numbered steps (or mention-order fallback) with the
// skills / agents / commands / MCPs / tools each step invokes.
//
// REGEX-derived (per Round 8): `buildFlowable` / `deriveFlow` in
// @/lib/claude-graph/flow parse the body — a lightweight pass, NOT an LLM read.
// Per-view filter: the entry picker only. Visual ported from
// `plans/cockpit/designs/cockpit-views-hifi.html` (renderFlow) over live data.

import { useEffect, useMemo, useState } from 'react';
import { buildFlowable, type FlowRefKind, type FlowSourceKind } from '@/lib/claude-graph';
import type { ClaudeConfig } from '@/lib/tauri-cmd';

interface FlowViewProps {
	config: ClaudeConfig | null;
}

const REF_GLYPH: Record<FlowRefKind, string> = {
	command: '⌘',
	agent: '★',
	skill: '◆',
	mcp: '⬡',
	tool: '⚙',
};
/** Token-backed accent per ref kind; tools have no `--nk-` token → neutral. */
function refColor(kind: FlowRefKind): string {
	return kind === 'tool' ? 'var(--fg-faint)' : `var(--nk-${kind})`;
}
const SOURCE_GLYPH: Record<FlowSourceKind, string> = { command: '⌘', agent: '★', skill: '◆' };
const SOURCE_LABEL: Record<FlowSourceKind, string> = {
	command: 'Commands',
	agent: 'Agents',
	skill: 'Skills',
};

export function FlowView({ config }: FlowViewProps) {
	const entries = useMemo(() => (config ? buildFlowable(config) : []), [config]);

	const [selected, setSelected] = useState<string | null>(null);
	// Keep a valid selection as the scan changes (default to the first entry).
	useEffect(() => {
		setSelected((cur) =>
			cur && entries.some((e) => e.key === cur) ? cur : (entries[0]?.key ?? null)
		);
	}, [entries]);

	const entry = entries.find((e) => e.key === selected) ?? null;

	// Group the picker options by source kind (command → agent → skill).
	const groups = useMemo(() => {
		const order: FlowSourceKind[] = ['command', 'agent', 'skill'];
		return order
			.map((kind) => ({ kind, items: entries.filter((e) => e.kind === kind) }))
			.filter((g) => g.items.length > 0);
	}, [entries]);

	if (!config) return <div className="ngwa-analyze-empty">Loading configuration…</div>;
	if (entries.length === 0)
		return (
			<div className="ngwa-analyze-empty">
				No extractable flows yet. A flow is the procedural step-sequence inside a command, agent, or
				skill body — numbered steps, <code>Task(…)</code> dispatches, or skill / command / MCP
				mentions. Add one to see it traced here.
			</div>
		);

	return (
		<div className="ngwa-graph">
			<div className="ngwa-graph-toolbar">
				<div className="ngwa-graph-title">
					<span className="ngwa-graph-glyph">⛓</span> Orchestration flow
				</div>
				<div className="ngwa-graph-meta">{entries.length} flowable</div>
				<span
					className="ngwa-flow-badge"
					title="Parsed from the body with a lightweight regex pass — not an LLM read."
				>
					regex-derived
				</span>
				<div className="ngwa-graph-spacer" />
				<select
					className="ngwa-graph-select"
					value={selected ?? ''}
					onChange={(e) => setSelected(e.target.value)}
					title="Pick a command, agent, or skill to trace"
				>
					{groups.map((g) => (
						<optgroup key={g.kind} label={SOURCE_LABEL[g.kind]}>
							{g.items.map((e) => (
								<option key={e.key} value={e.key}>
									{e.name}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</div>
			<div className="ngwa-graph-stage" style={{ overflow: 'auto', background: 'var(--bg-base)' }}>
				<div className="ngwa-flow">
					<p className="ngwa-flow-note">
						<b>How this is built:</b> the Capability graph reads <i>declarative</i> wiring from
						frontmatter. This <i>procedural</i> sequence is parsed from the body — numbered steps,{' '}
						<code>Task(…)</code> dispatches, and skill / command / MCP mentions — a lightweight
						regex pass, not an LLM read. Treat it as a best-effort trace.
					</p>

					{entry && (
						<>
							<div className="ngwa-flow-source">
								<span className="g" style={{ color: refColor(entry.kind) }}>
									{SOURCE_GLYPH[entry.kind]}
								</span>
								<b>{entry.name}</b>
								<span className="meta">
									{entry.kind} ·{' '}
									{entry.model.derivation === 'numbered'
										? `${entry.model.steps.length}-step pipeline`
										: `${entry.model.steps.length} dispatches (mention-order)`}
									{entry.model.loop && ' · ↺ loops back'}
								</span>
							</div>

							<div className="ngwa-flow-chain">
								{entry.model.steps.map((st, i) => (
									<div key={st.n} className="ngwa-flow-stepwrap">
										<div className="ngwa-flow-step">
											<div className="ngwa-flow-num">{st.n}</div>
											<div className="ngwa-flow-stepbody">
												<div className="ngwa-flow-label">{st.label}</div>
												{st.refs.length > 0 && (
													<div className="ngwa-flow-refs">
														{st.refs.map((r) => (
															<span
																key={`${r.kind}:${r.name}`}
																className="ngwa-flow-ref"
																style={{ borderLeftColor: refColor(r.kind) }}
															>
																<span className="g" style={{ color: refColor(r.kind) }}>
																	{REF_GLYPH[r.kind]}
																</span>
																{r.name}
																<span className="rk">{r.kind}</span>
															</span>
														))}
													</div>
												)}
											</div>
										</div>
										{i < entry.model.steps.length - 1 && <div className="ngwa-flow-conn" />}
									</div>
								))}
							</div>

							{entry.model.loop && (
								<div className="ngwa-flow-loop">
									↺ the body suggests this sequence loops back before it completes.
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
