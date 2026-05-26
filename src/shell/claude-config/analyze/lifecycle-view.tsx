// Hook lifecycle (Phase 4 · D-03 "Lifecycle" view) — the Ngwa Analyze
// `surface=life` swimlane. Places each scanned hook on the session event it
// fires at, laid out in firing order (SessionStart → … → SessionEnd). Rides the
// current scan (`config.hooks`); no Rust change. Per-view filter: scope.
//
// Visual ported from `plans/cockpit/designs/cockpit-views-hifi.html` (renderLife)
// against live data — Theme A · Dusk Wood, JetBrains Mono labels.

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/components/ui/utils';
import { hookMatcher, scopeKey } from '@/lib/claude-graph';
import type { ClaudeConfig, ClaudeHook } from '@/lib/tauri-cmd';
import { KIND_GLYPH } from './graph-shared';

interface LifecycleViewProps {
	config: ClaudeConfig | null;
	/** Sidebar scope: 'all' | 'personal' | `project:<basename>`. */
	scope: string;
}

/** Claude session events in firing order. Each lane is a "station" on the
 *  timeline; hooks bucket onto their event. Anything outside this set lands in
 *  a trailing "Other" station so no hook is ever silently dropped. */
const LIFECYCLE: { event: string; blurb: string }[] = [
	{ event: 'SessionStart', blurb: 'session boots — load context' },
	{ event: 'UserPromptSubmit', blurb: 'each user message, before the model sees it' },
	{ event: 'PreToolUse', blurb: 'before a tool runs — gate / block' },
	{ event: 'PostToolUse', blurb: 'after a tool runs — react / audit' },
	{ event: 'Notification', blurb: 'permission / idle notifications' },
	{ event: 'Stop', blurb: 'the model finishes responding' },
	{ event: 'SubagentStop', blurb: 'a spawned subagent finishes' },
	{ event: 'PreCompact', blurb: 'before the transcript is compacted' },
	{ event: 'SessionEnd', blurb: 'session tears down' },
];
const KNOWN_EVENTS = new Set(LIFECYCLE.map((l) => l.event));

function scopeShort(key: string): string {
	if (key === 'personal') return 'personal';
	return key.startsWith('project:') ? key.slice(8) : key;
}
function scopeLabel(key: string): string {
	if (key === 'all') return 'All scopes';
	if (key === 'personal') return 'Personal';
	return key.startsWith('project:') ? key.slice(8) : key;
}

export function LifecycleView({ config, scope }: LifecycleViewProps) {
	const [scopeSel, setScopeSel] = useState(scope);
	useEffect(() => setScopeSel(scope), [scope]);

	const allHooks = config?.hooks ?? [];

	const scopeOptions = useMemo(() => {
		const s = new Set<string>();
		for (const h of allHooks) s.add(scopeKey(h.scope, h.projectRoot));
		return [...s].sort((a, b) =>
			a === 'personal' ? -1 : b === 'personal' ? 1 : a.localeCompare(b)
		);
	}, [allHooks]);

	const hooks = useMemo(
		() =>
			scopeSel === 'all'
				? allHooks
				: allHooks.filter((h) => scopeKey(h.scope, h.projectRoot) === scopeSel),
		[allHooks, scopeSel]
	);

	// Bucket hooks by event lane, preserving firing order + a trailing catch-all.
	const stations = useMemo(() => {
		const byEvent = new Map<string, ClaudeHook[]>();
		for (const h of hooks) {
			const key = KNOWN_EVENTS.has(h.event) ? h.event : 'Other';
			(byEvent.get(key) ?? byEvent.set(key, []).get(key)!).push(h);
		}
		const lanes = LIFECYCLE.map((l) => ({ ...l, hooks: byEvent.get(l.event) ?? [] }));
		const other = byEvent.get('Other');
		if (other?.length) lanes.push({ event: 'Other', blurb: 'unrecognized event', hooks: other });
		return lanes;
	}, [hooks]);

	// Data-driven insight callouts: shared tool-matchers (the "Bash hub"), and
	// empty stations (context-loading / audit candidates).
	const insights = useMemo(() => {
		const out: { tone: 'gate' | 'note'; text: string }[] = [];
		const toolMatchers = new Map<string, number>();
		for (const h of hooks) {
			if (h.event === 'PreToolUse' || h.event === 'PostToolUse') {
				const m = hookMatcher(h);
				if (m) toolMatchers.set(m, (toolMatchers.get(m) ?? 0) + 1);
			}
		}
		for (const [m, n] of [...toolMatchers].sort((a, b) => b[1] - a[1])) {
			if (n > 1)
				out.push({
					tone: 'gate',
					text: `${n} hooks share the ${m} matcher — every ${m}-using primitive passes through all of them.`,
				});
		}
		const empty = stations
			.filter((s) => s.event !== 'Other' && s.hooks.length === 0)
			.map((s) => s.event);
		if (empty.length)
			out.push({
				tone: 'note',
				text: `${empty.length} event${empty.length > 1 ? 's' : ''} with no hooks (${empty.join(', ')}) — candidates for SessionStart context-loading or PostToolUse audit.`,
			});
		return out;
	}, [hooks, stations]);

	if (!config) return <div className="ngwa-analyze-empty">Loading configuration…</div>;
	if (allHooks.length === 0)
		return (
			<div className="ngwa-analyze-empty">
				No hooks configured. Hooks are JSON-merged blocks in <code>settings.json</code> that run at
				a session event — add one to see it placed on its lifecycle lane.
			</div>
		);

	return (
		<div className="ngwa-graph">
			<div className="ngwa-graph-toolbar">
				<div className="ngwa-graph-title">
					<span className="ngwa-graph-glyph">⚡</span> Hook lifecycle
				</div>
				<div className="ngwa-graph-meta">
					{hooks.length} hooks · {stations.filter((s) => s.hooks.length).length} active events
				</div>
				<div className="ngwa-graph-spacer" />
				<select
					className="ngwa-graph-select"
					value={scopeSel}
					onChange={(e) => setScopeSel(e.target.value)}
					title="Narrow to one scope / project"
				>
					<option value="all">All scopes</option>
					{scopeOptions.map((s) => (
						<option key={s} value={s}>
							{scopeLabel(s)}
						</option>
					))}
				</select>
			</div>
			<div className="ngwa-graph-stage" style={{ overflow: 'auto', background: 'var(--bg-base)' }}>
				<div className="ngwa-life">
					<p className="ngwa-life-lede">
						A Claude session fires these events in order. Each hook is a JSON-merged block in{' '}
						<code>settings.json</code> that runs at its event — gating (<code>PreToolUse</code>) or
						reacting (<code>Stop</code>, <code>PostToolUse</code>, …).
					</p>
					<div className="ngwa-life-track">
						{stations.map((st, i) => (
							<div key={st.event} className={cn('ngwa-life-station', st.hooks.length && 'active')}>
								<div className="ngwa-life-rail">
									<span className="ngwa-life-tick" />
									{i < stations.length - 1 && <span className="ngwa-life-line" />}
								</div>
								<div className="ngwa-life-ev">{st.event}</div>
								<div className="ngwa-life-blurb">{st.blurb}</div>
								<div className="ngwa-life-chips">
									{st.hooks.length === 0 ? (
										<span className="ngwa-life-empty">—</span>
									) : (
										st.hooks.map((h) => {
											const m = hookMatcher(h);
											return (
												<div
													key={`${h.event}:${h.name}:${h.settingsPath}:${m ?? '*'}`}
													className="ngwa-life-chip"
												>
													<span className="g">{KIND_GLYPH.hook}</span>
													<span className="nm">{h.name}</span>
													{m && <span className="sc match">{m}</span>}
													<span className="sc">{scopeShort(scopeKey(h.scope, h.projectRoot))}</span>
												</div>
											);
										})
									)}
								</div>
							</div>
						))}
					</div>
					{insights.length > 0 && (
						<div className="ngwa-life-insights">
							{insights.map((ins) => (
								<div key={ins.text} className={cn('ngwa-life-insight', ins.tone)}>
									<span className="dot" />
									{ins.text}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
