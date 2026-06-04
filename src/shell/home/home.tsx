// Home — composable free-form canvas. Shell built-ins (greeting, sessions,
// quick actions, scratchpad) live alongside pkg-contributed widgets (tasks,
// inbox, boards, finance). Read-only by default; `Customize` flips edit mode
// with a drag palette, drag-to-reposition, and layout persistence.
//
// Design source: design/shell/concepts/03-screens/16-home.html (concept) +
// 16-home.artifact.html (live artifact). This file is the shell-native port:
// no bridge polyfill, layout persisted via localStorage (will move to SQLite
// once a `home_layout` migration lands), widget bodies use placeholder data
// pending the pkg-source wiring.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
	Canvas,
	type CanvasHandle,
	type ItemId,
	type ItemRenderState,
	type Placement,
	type Viewport,
} from '@ikenga/contract/canvas';
import { dailyAddress, quoteOfTheDay, partOfDay } from '@/lib/lore';
import { sessionsListQueryOptions, type SessionSummary } from '@/lib/queries/sessions';
import { listScratchpads } from '@/lib/iyke/memory';

// ───────────────────────── session helpers ─────────────────────────
// Map a SessionSummary's last activity timestamp to a coarse state used by
// the home widget. "live" = touched in the last 5min; "warm" = within the
// last hour (still recent enough to pick back up without context loss); the
// rest fall through to "idle".

type SessionState = 'live' | 'warm' | 'idle';

function sessionState(s: SessionSummary, nowMs: number): SessionState {
	const last = s.lastMessageAt ? Date.parse(s.lastMessageAt) : Date.parse(s.startedAt);
	if (Number.isNaN(last)) return 'idle';
	const age = nowMs - last;
	if (age < 5 * 60_000) return 'live';
	if (age < 60 * 60_000) return 'warm';
	return 'idle';
}

function shortAgo(iso: string | null, nowMs: number): string {
	if (!iso) return '';
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return '';
	const min = Math.max(0, Math.round((nowMs - then) / 60_000));
	if (min < 60) return `${min}m`;
	if (min < 60 * 24) return `${Math.floor(min / 60)}h ${min % 60}m`;
	return `${Math.round(min / 1440)}d ago`;
}

// Heuristic agent tag — pulls a leading slash-command from the title or the
// first segment of projectDir. Cheap and right most of the time; the canonical
// detectAgentSlug() in @/lib/queries/sessions is overkill for a 4-char chip.
function quickAgentTag(s: SessionSummary): string {
	if (s.title) {
		const m = s.title.trim().match(/^\/?([a-z][a-z0-9-]{0,6})/i);
		if (m) return m[1].toLowerCase().slice(0, 6);
	}
	const seg = (s.projectDir || '').split('/').filter(Boolean).pop();
	return seg ? seg.slice(0, 6) : '—';
}

// ───────────────────────── icons ─────────────────────────

const Icons = {
	clock: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 3" />
		</svg>
	),
	sessions: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<path d="M4 6h16M4 12h10M4 18h6" />
		</svg>
	),
	quick: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<polyline points="9 11 12 14 22 4" />
			<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
		</svg>
	),
	pad: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<path d="M4 4h12l4 4v12H4z" />
			<polyline points="14 4 14 8 20 8" />
		</svg>
	),
	tasks: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<rect x="4" y="4" width="16" height="16" rx="2" />
			<polyline points="8 12 11 15 16 9" />
		</svg>
	),
	mail: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<polyline points="3 7 12 13 21 7" />
		</svg>
	),
	studio: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<polyline points="9 9 15 12 9 15" />
		</svg>
	),
	finance: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<polyline points="3 17 9 11 13 15 21 7" />
			<polyline points="14 7 21 7 21 14" />
		</svg>
	),
	cron: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<circle cx="12" cy="12" r="9" />
			<line x1="12" y1="6" x2="12" y2="12" />
			<line x1="12" y1="12" x2="16" y2="14" />
		</svg>
	),
	agents: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<circle cx="12" cy="9" r="3" />
			<path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
		</svg>
	),
	recenter: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<polyline points="9 14 4 14 4 9" />
			<polyline points="15 10 20 10 20 15" />
			<polyline points="20 4 14 10" />
			<polyline points="4 20 10 14" />
		</svg>
	),
	edit: (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={true}>
			<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" />
		</svg>
	),
};

// ───────────────────────── layout types ─────────────────────────

type WidgetKind =
	| 'greeting'
	| 'sessions'
	| 'finance'
	| 'quick'
	| 'pad'
	| 'tasks'
	| 'inbox'
	| 'boards';

interface WidgetPlacement {
	id: string;
	kind: WidgetKind;
	x: number;
	y: number;
	w: number;
	h: number;
	patina?: 'warm';
}

// Default placement. Coordinates are canvas-space — the stage autofits to
// the viewport, scaling down only (never up).
const DEFAULT_LAYOUT: WidgetPlacement[] = [
	{ id: 'greeting', kind: 'greeting', x: 20, y: 30, w: 560, h: 320 },
	{ id: 'sessions', kind: 'sessions', x: 20, y: 380, w: 440, h: 260, patina: 'warm' },
	{ id: 'finance', kind: 'finance', x: 20, y: 660, w: 440, h: 200 },
	{ id: 'quick', kind: 'quick', x: 620, y: 30, w: 400, h: 240 },
	{ id: 'pad', kind: 'pad', x: 1060, y: 30, w: 320, h: 240 },
	{ id: 'tasks', kind: 'tasks', x: 620, y: 300, w: 360, h: 240 },
	{ id: 'inbox', kind: 'inbox', x: 1020, y: 300, w: 360, h: 240 },
	{ id: 'boards', kind: 'boards', x: 620, y: 570, w: 360, h: 200 },
];

const PALETTE_SHELL = [
	{ id: 'greeting', title: 'Greeting', icon: Icons.clock },
	{ id: 'sessions', title: 'Recent sessions', icon: Icons.sessions },
	{ id: 'quick', title: 'Quick actions', icon: Icons.quick },
	{ id: 'pad', title: 'Scratchpad', icon: Icons.pad },
	{ id: 'clock', title: 'World clock', icon: Icons.clock, placed: false },
];

const PALETTE_PKG = [
	{ id: 'tasks', title: "Today's tasks", icon: Icons.tasks, meta: 'tasks' },
	{ id: 'inbox', title: 'Inbox triage', icon: Icons.mail, meta: 'email' },
	{ id: 'boards', title: 'Active boards', icon: Icons.studio, meta: 'studio' },
	{ id: 'finance', title: 'Week so far', icon: Icons.finance, meta: 'finance' },
	{ id: 'cron', title: 'Scheduled runs', icon: Icons.cron, meta: 'cron', placed: false },
	{ id: 'agents', title: 'Agent runs', icon: Icons.agents, meta: 'agents', placed: false },
];

const LS_LAYOUT = 'ikenga:home:layout';

// ───────────────────────── placeholder widget data ─────────────────────────
// Sessions + scratchpad are wired to real shell sources below; the remaining
// MOCK_* blocks back pkg-contributed widgets that land when each pkg is
// installed (tasks, inbox, boards, finance). Quick actions stays mock until
// the command-palette grows a usage-history table.

const MOCK_TASKS = [
	{ id: 't1', title: 'Review Q2 board', due: '2h', priority: 'high' },
	{ id: 't2', title: 'Sign off vendor agreement', due: 'EOD', priority: 'med' },
	{ id: 't3', title: 'Follow up · Iyke', due: 'Wed', priority: 'med' },
	{ id: 't4', title: 'Approve Mar royalty run', due: 'Wed', priority: 'low' },
];

const MOCK_INBOX = [
	{ id: 'm1', from: 'Sarah', subject: 'Q2 close timing', time: '10:14', sev: 'warn' },
	{ id: 'm2', from: 'DSP partner', subject: 'Revised partnership', time: '09:02', sev: 'info' },
	{ id: 'm3', from: 'Newsletter', subject: 'Draft feedback', time: 'Mon', sev: 'info' },
	{ id: 'm4', from: 'Tenant 590', subject: 'Contract redlines', time: 'Mon', sev: 'info' },
];

const MOCK_BOARDS = [
	{ id: 'b1', name: 'Q2 strategic shift', frames: 3, state: 'active' },
	{ id: 'b2', name: 'Tenant 590 close', frames: 7, state: 'active' },
	{ id: 'b3', name: 'Brand sketch v3', frames: 4, state: 'paused' },
];

const MOCK_FINANCE = { wtd: 28400, change: 12, series: [3.2, 4.1, 5.0, 5.8, 6.3, 6.9, 7.1] };

const MOCK_COMMANDS = [
	{ label: 'New Claude session', keybind: '⌘ N', hint: 'recent' },
	{ label: 'Open scratchpad', keybind: '⌘ ⇧ N', hint: 'recent' },
	{ label: 'Triage inbox', keybind: '⌘ I', hint: '3 unread' },
	{ label: 'Storyboard · Q2 shift', keybind: '⌘ E', hint: 'last opened' },
	{ label: 'Run royalty refresh', keybind: '⌘ R', hint: 'weekly' },
];

// ───────────────────────── widget bodies ─────────────────────────

// Status dot. The colour carries the state (live/warm/danger/agent), so the
// span also gets an accessible label + role="img" — colour alone fails WCAG
// 1.4.1 Use of Color. `cls` is the dotCls()/dot() modifier; `label` the
// human-readable state ('Live', 'Warm', 'Idle', …).
function DotSpan({ cls, label }: { cls: string; label: string }) {
	return <span className={`w-dot ${cls}`.trim()} role="img" aria-label={label} />;
}

function GreetingBody({ name }: { name: string }) {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(t);
	}, []);
	const tod = dailyAddress(now);
	const q = quoteOfTheDay(now, 'daily-address');
	const { data: sessions } = useQuery(sessionsListQueryOptions(null, 12));
	const counts = useMemo(() => {
		const nowMs = now.getTime();
		let live = 0;
		let warm = 0;
		for (const s of sessions ?? []) {
			const st = sessionState(s, nowMs);
			if (st === 'live') live += 1;
			else if (st === 'warm') warm += 1;
		}
		return { live, warm };
	}, [sessions, now]);
	const { live, warm } = counts;
	const shape =
		live === 0 && warm === 0
			? 'No sessions open. A clean slate.'
			: live > 0 && warm > 0
				? `${live} session${live === 1 ? '' : 's'} still open, ${warm} paused. ${live > 1 ? "There's momentum to pick back up." : "Pick it back up when you're ready."}`
				: `${live + warm} session${(live + warm) === 1 ? '' : 's'} still ${live ? 'open' : 'paused'}.`;
	return (
		<>
			<h1>
				{tod.igbo}, <em>{name}</em>.
			</h1>
			<div className="gloss">
				<span className="english">{tod.english}</span>
				<span className="sep">·</span>
				<span>
					{now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
				</span>
				<span className="sep">·</span>
				<span>{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
				<span className="sep">·</span>
				<span>
					{live} active session{live === 1 ? '' : 's'}
				</span>
			</div>
			<div className="shape">{shape}</div>
			{q && (
				<div className="quote">
					<div className="quote-body">
						&ldquo;{q.text}&rdquo;
						{q.gloss && <span className="quote-gloss">{q.gloss}</span>}
					</div>
					<div className="quote-attr">
						— {q.source}
						{q.work ? ` · ${q.work}` : ''}
					</div>
				</div>
			)}
		</>
	);
}

function SessionsBody() {
	// 30s refetch so the home stays current without bouncing on every focus.
	const { data, isLoading } = useQuery(sessionsListQueryOptions(null, 6));
	const nowMs = Date.now();
	const sessions = data ?? [];
	if (isLoading && sessions.length === 0) {
		return (
			<div
				style={{ color: 'var(--fg-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}
			>
				Loading…
			</div>
		);
	}
	if (sessions.length === 0) {
		return (
			<div
				style={{ color: 'var(--fg-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}
			>
				No recent sessions.
			</div>
		);
	}
	const dotCls = (st: SessionState) => (st === 'live' ? 'live' : st === 'warm' ? 'warm' : '');
	return (
		<>
			{sessions.map((s) => {
				const st = sessionState(s, nowMs);
				const title = (s.title?.trim() || s.sessionId.slice(0, 8)).replace(/^\/\S+\s*/, '');
				return (
					<div className="w-row" key={s.sessionId}>
						<DotSpan
							cls={dotCls(st)}
							label={st === 'live' ? 'Live' : st === 'warm' ? 'Warm' : 'Idle'}
						/>
						<span className="w-label">
							<span className="w-agent-tag">{quickAgentTag(s)}</span>
							{title}
						</span>
						<span className="w-meta">{shortAgo(s.lastMessageAt ?? s.startedAt, nowMs)}</span>
					</div>
				);
			})}
		</>
	);
}

function QuickBody() {
	return (
		<>
			{MOCK_COMMANDS.map((c, i) => (
				<div className="qrow" key={i}>
					<span>{c.label}</span>
					<span className="qmeta">{c.hint}</span>
					<span className="kbd">{c.keybind}</span>
				</div>
			))}
		</>
	);
}

function PadBody() {
	// Lightweight: list scratchpads, render preview of the most-recent entry.
	// Avoids a second read-by-name fetch — `preview` is exactly what we want
	// on the home tile (full body lives at `/scratchpads`).
	const { data, isLoading } = useQuery({
		queryKey: ['home', 'scratchpads'],
		queryFn: () => listScratchpads(),
		staleTime: 30_000,
		refetchOnWindowFocus: true,
	});
	const first = data?.scratchpads?.[0];
	if (isLoading && !first) {
		return (
			<div
				style={{ color: 'var(--fg-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}
			>
				Loading…
			</div>
		);
	}
	if (!first) {
		return (
			<div
				style={{ color: 'var(--fg-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}
			>
				No scratchpads yet.
			</div>
		);
	}
	const edited = new Date(first.updated_at).toLocaleString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		month: 'short',
		day: 'numeric',
	});
	return (
		<>
			&ldquo;{first.preview || first.name}&rdquo;
			<div className="pad-meta">last edited · {edited}</div>
		</>
	);
}

function TasksBody() {
	const dot = (p: string) => (p === 'high' ? 'warm' : '');
	return (
		<>
			{MOCK_TASKS.map((t) => (
				<div className="w-row" key={t.id}>
					<DotSpan
						cls={dot(t.priority)}
						label={t.priority === 'high' ? 'High priority' : 'Normal priority'}
					/>
					<span className="w-label">{t.title}</span>
					<span className="w-meta">{t.due}</span>
				</div>
			))}
		</>
	);
}

function InboxBody() {
	const dot = (s: string) => (s === 'warn' ? 'warm' : s === 'danger' ? 'danger' : '');
	return (
		<>
			{MOCK_INBOX.map((m) => (
				<div className="w-row" key={m.id}>
					<DotSpan
						cls={dot(m.sev)}
						label={m.sev === 'warn' ? 'Warning' : m.sev === 'danger' ? 'Urgent' : 'Info'}
					/>
					<span className="w-label">
						{m.from} · {m.subject}
					</span>
					<span className="w-meta">{m.time}</span>
				</div>
			))}
		</>
	);
}

function BoardsBody() {
	return (
		<>
			{MOCK_BOARDS.map((b) => (
				<div className="w-row" key={b.id}>
					<DotSpan
						cls={b.state === 'active' ? 'agent' : ''}
						label={b.state === 'active' ? 'Active' : 'Paused'}
					/>
					<span className="w-label">{b.name}</span>
					<span className="w-meta">{b.frames} frames</span>
				</div>
			))}
		</>
	);
}

function FinanceBody() {
	const { wtd, change, series } = MOCK_FINANCE;
	const max = Math.max(...series);
	const min = Math.min(...series);
	const span = Math.max(0.0001, max - min);
	const pts = series
		.map((v, i) => {
			const x = (i / Math.max(1, series.length - 1)) * 400;
			const y = 32 - ((v - min) / span) * 28 - 2;
			return `${x},${y.toFixed(1)}`;
		})
		.join(' ');
	return (
		<>
			<div
				style={{
					fontSize: 11,
					color: 'var(--fg-faint)',
					letterSpacing: '0.04em',
					fontFamily: 'var(--font-mono, ui-monospace)',
				}}
			>
				Mon → today · USD
			</div>
			<div className="figure">
				${(wtd / 1000).toFixed(1)}k <em>+{change}%</em>
			</div>
			<svg
				className="spark"
				viewBox="0 0 400 32"
				preserveAspectRatio="none"
				role="img"
				aria-label={`Revenue sparkline: Mon to today, ${(wtd / 1000).toFixed(1)}k USD, ${change > 0 ? '+' : ''}${change}%`}
			>
				{/* role="img" + aria-label on the svg makes it a leaf in the a11y
				    tree, so these polylines are already presentational — no
				    per-child aria-hidden needed (and Biome flags it as unsafe). */}
				<polyline
					points={pts}
					fill="none"
					stroke="var(--achievement, hsl(42,78%,54%))"
					strokeWidth="1.6"
				/>
				<polyline points={`${pts} 400,32 0,32`} fill="var(--achievement-soft)" />
			</svg>
		</>
	);
}

// Tag count for the Sessions header. Lives outside widgetMeta so the
// `tag` field can read live query state without making widgetMeta a hook.
function SessionsTag() {
	const { data } = useQuery(sessionsListQueryOptions(null, 12));
	const nowMs = Date.now();
	const live = (data ?? []).reduce((n, s) => (sessionState(s, nowMs) === 'live' ? n + 1 : n), 0);
	return <>{live} active</>;
}

function widgetMeta(kind: WidgetKind): {
	title: string;
	icon: ReactNode;
	tag: ReactNode;
	Body: () => ReactNode;
	cls?: string;
} | null {
	switch (kind) {
		case 'sessions':
			return {
				title: 'Recent sessions',
				icon: Icons.sessions,
				tag: <SessionsTag />,
				Body: SessionsBody,
			};
		case 'quick':
			return { title: 'Quick actions', icon: Icons.quick, tag: '⌘ K', Body: QuickBody };
		case 'pad':
			return { title: 'Scratchpad', icon: Icons.pad, tag: 'auto', Body: PadBody, cls: 'w-pad' };
		case 'tasks':
			return { title: "Today's tasks", icon: Icons.tasks, tag: 'pkg · tasks', Body: TasksBody };
		case 'inbox':
			return { title: 'Inbox triage', icon: Icons.mail, tag: 'pkg · email', Body: InboxBody };
		case 'boards':
			return { title: 'Active boards', icon: Icons.studio, tag: 'pkg · studio', Body: BoardsBody };
		case 'finance':
			return {
				title: 'Week so far',
				icon: Icons.finance,
				tag: 'pkg · finance',
				Body: FinanceBody,
				cls: 'w-finance',
			};
		default:
			return null;
	}
}

// ───────────────────────── canvas ─────────────────────────
// The free-form pan/zoom/grid-snap surface now lives in the reusable
// <Canvas> primitive (`@ikenga/contract/canvas`). Home stays the source of
// truth for `layout` (+ localStorage persistence), `editMode`, `selectedId`,
// and the viewport; Canvas drives the gestures and calls back on change.
//
// Two adapters bridge home's legacy `WidgetPlacement[]` (ordered, kind-tagged)
// to the canvas's `Record<ItemId, Placement>`: `toRecord` strips to geometry,
// `applyRecord` writes moved coordinates back onto the ordered array so order
// + kind + patina survive the round-trip.

function toRecord(layout: WidgetPlacement[]): Record<ItemId, Placement> {
	const rec: Record<ItemId, Placement> = {};
	for (const w of layout) {
		rec[w.id as ItemId] = { x: w.x, y: w.y, w: w.w, h: w.h };
	}
	return rec;
}

function applyRecord(layout: WidgetPlacement[], rec: Record<ItemId, Placement>): WidgetPlacement[] {
	return layout.map((w) => {
		const p = rec[w.id as ItemId];
		return p ? { ...w, x: p.x, y: p.y, w: p.w, h: p.h } : w;
	});
}

export function Home() {
	// Acknowledge partOfDay so its import survives tree-shaking under noUnused.
	void partOfDay;

	const [layout, setLayout] = useState<WidgetPlacement[]>(() => {
		try {
			const raw = localStorage.getItem(LS_LAYOUT);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed) && parsed.length) return parsed;
			}
		} catch {
			// ignore
		}
		return DEFAULT_LAYOUT;
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
		} catch {
			// ignore
		}
	}, [layout]);

	const [editMode, setEditMode] = useState(false);
	const [selectedId, setSelectedId] = useState<ItemId | null>(null);
	const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });

	const canvasHandle = useRef<CanvasHandle>(null);

	const layoutRecord = useMemo(() => toRecord(layout), [layout]);

	// renderItem owns the widgetMeta lookup + Body invocation + greeting
	// special-case. It returns the consumer's positioned element (home-greeting
	// or home-widget) carrying its base class + height; Canvas injects data-id,
	// left/top/width geometry, and the is-selected class.
	function renderItem(w: WidgetPlacement, state: ItemRenderState): ReactNode {
		if (w.kind === 'greeting') {
			return (
				<div className="home-greeting" style={{ minHeight: state.placement.h }}>
					<GreetingBody name="friend" />
				</div>
			);
		}
		const m = widgetMeta(w.kind);
		if (!m) return null;
		const Body = m.Body;
		return (
			<div
				className={`home-widget ${m.cls ?? ''}`.trim()}
				data-patina={w.patina ?? undefined}
				style={{ height: state.placement.h }}
			>
				<div className="w-head">
					<div className="w-icon">{m.icon}</div>
					<div className="w-title">{m.title}</div>
					<div className="w-tag">{m.tag}</div>
				</div>
				<div className="w-body">
					<Body />
				</div>
			</div>
		);
	}

	return (
		<Canvas<WidgetPlacement>
			ref={canvasHandle}
			items={layout}
			itemId={(w) => w.id as ItemId}
			itemKind={(w) => w.kind}
			layout={layoutRecord}
			viewport={viewport}
			editMode={editMode}
			selectedId={selectedId}
			gridSnap={12}
			ariaLabel="Home canvas"
			renderItem={renderItem}
			onLayoutChange={(rec) => setLayout((L) => applyRecord(L, rec))}
			onViewportChange={setViewport}
			onEditModeChange={setEditMode}
			onSelectionChange={setSelectedId}
		>
			<div className="ikenga-canvas-bar">
				<div className="crumb">
					App · <b>Home</b>
				</div>
				<div className="hint">
					<span className="kbd">space</span> drag · <span className="kbd">↑↓←→</span> pan ·{' '}
					<span className="kbd">+/-</span> zoom · <span className="kbd">dbl-click</span> re-fit
				</div>
				<button className="btn" type="button" onClick={() => canvasHandle.current?.autoFit(true)}>
					{Icons.recenter}
					Recenter
				</button>
				<button
					className={`btn${editMode ? ' is-primary' : ''}`}
					type="button"
					aria-pressed={editMode}
					onClick={() => {
						setEditMode((v) => !v);
						setSelectedId(null);
					}}
				>
					{Icons.edit}
					{editMode ? 'Done' : 'Customize'}
				</button>
			</div>

			<aside
				className="home-palette"
				aria-label="Widget palette"
				aria-hidden={!editMode}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="head">
					<div className="ptag">Customize</div>
					<h3>Widget palette</h3>
					<p>Drag any item onto the canvas. Placed widgets are dimmed.</p>
				</div>
				<div className="section">
					<h4>Shell · {PALETTE_SHELL.length} widgets</h4>
					<div className="list">
						{PALETTE_SHELL.map((p) => {
							const placed = layout.some((l) => l.id === p.id);
							return (
								<div key={p.id} className={`item${placed ? ' is-placed' : ''}`}>
									<div className="pic">{p.icon}</div>
									<div className="title">{p.title}</div>
									<span className="meta">{placed ? 'placed' : 'drag'}</span>
								</div>
							);
						})}
					</div>
				</div>
				<div className="section">
					<h4>Pkgs · {PALETTE_PKG.length} available</h4>
					<div className="list">
						{PALETTE_PKG.map((p) => {
							const placed = layout.some((l) => l.id === p.id);
							return (
								<div key={p.id} className={`item${placed ? ' is-placed' : ''}`}>
									<div className="pic">{p.icon}</div>
									<div className="title">{p.title}</div>
									<span className="meta">pkg · {p.meta}</span>
								</div>
							);
						})}
					</div>
				</div>
			</aside>
		</Canvas>
	);
}
