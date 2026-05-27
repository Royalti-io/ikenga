// Ngwa surfaces (WP-07) — the read-WRITE Claude-config manager.
//
// This is the SUPERSET of the read-only /claude browser: it ports the rich
// detail (body/script preview, supporting-files tree, typed relationship
// chips, precedence/override signal) and decorates it with write actions
// (enable/disable · move · copy · remove/delete · import/install · reveal).
//
// Two MANAGE surfaces share one data model + one detail pane (D-02):
//   • Browse   — 2-pane (list │ resizable divider │ detail superset).
//   • Registry — full-width 8-col table + @filter DSL + bulk actions; detail
//                opens in a right-sliding drawer that reuses the same superset.
// ANALYZE surfaces (graph/map/life/health/flow) are Phase 4 — placeholder.
//
// Reads `?surface=&scope=&kind=` (threaded by WP-06's Ngwa sidebar) to pick
// the surface, scope filter, and kind filter. All reads/writes go through the
// WP-05 hooks in `lib/queries/claude-config.ts` (mock-backed in dev).
//
// Design refs: designs/cockpit-shell-v2-mode.html (D-02) +
//              designs/cockpit-ngwa-hifi.html (D-05).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, List as ListIcon } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { Markdown } from '@/components/markdown';
import { shortPath } from '@/lib/home';
import {
	claudeConfigReadFile,
	type ClaudeAgent,
	type ClaudeCommand,
	type ClaudeConfig,
	type ClaudeHook,
	type ClaudeMcp,
	type ClaudeSkill,
	type ClaudeStoreEntry,
	type ClaudeStoreKind,
	type ClaudeStoreScope,
	type Project,
} from '@/lib/tauri-cmd';
import {
	claudeStoreQueryOptions,
	useCopyPrimitive,
	useDisablePrimitive,
	useEnablePrimitive,
	useImportToStore,
	useMovePrimitive,
	useRemovePrimitive,
	type ConfigFormat,
	type EngineId,
	type KindStatus,
} from '@/lib/queries/claude-config';

import { Chips, FrontmatterGrid } from './list-detail';
import { AnalyzeSurface } from './analyze';
import { EngineGlyph } from './engine-glyph';
import { WriteTranscodeDrawer, isCrossEngineCopyable } from './write-drawer';

// ─── URL-param vocabularies (must match WP-06's ngwa-mode.tsx) ──────────────
export type NgwaSurfaceId = 'browse' | 'registry' | 'graph' | 'map' | 'life' | 'health' | 'flow';
// `project:<id>` selects one specific project; `all`/`personal` are the
// cross-cutting defaults. The sidebar enumerates one `project:<id>` per
// scanned project root (WP-06 ↔ WP-07 seam).
export type NgwaScopeId = 'all' | 'personal' | `project:${string}`;
export type NgwaKindId = 'skills' | 'agents' | 'commands' | 'hooks' | 'mcps' | 'store';
// The SYSTEM facet (WP-20 / D-08) is multi-select — peers with Scope + Kind in
// the sidebar but, unlike them, can hold several values at once. It threads
// through the URL as a comma-separated `sys` param; an absent / empty param
// means "all present systems on".
export type NgwaSystemId = EngineId; // 'claude' | 'gemini' | 'codex'

// ─── Engine identity (shared with the Ngwa sidebar) ─────────────────────────
// Display name, the 2-char badge (CL/GM/CX), the `.evhead.eng.*` modifier, and
// the engine-tint var — mirrors the D-08 mockup. The badge class on a row is
// the lowercase engine id; the sub-header modifier is the short cl/gm/cx code.
export const ENGINE_ORDER: readonly NgwaSystemId[] = ['claude', 'gemini', 'codex'];

export const ENGINE_META: Record<
	NgwaSystemId,
	{ display: string; badge: string; code: 'cl' | 'gm' | 'cx' }
> = {
	claude: { display: 'Claude Code', badge: 'CL', code: 'cl' },
	gemini: { display: 'Gemini', badge: 'GM', code: 'gm' },
	codex: { display: 'Codex', badge: 'CX', code: 'cx' },
};

/** Absent `system` ⇒ `"claude"` (WP-19 contract). */
const systemOf = (e: { system?: EngineId }): NgwaSystemId => e.system ?? 'claude';
/** Absent `status` ⇒ `"active"` (WP-19 contract). */
const statusOf = (e: { status?: KindStatus }): KindStatus => e.status ?? 'active';

// Map a serialization format onto the short row chip + its tint class.
const FORMAT_CHIP: Record<ConfigFormat, { label: string; cls: 'json' | 'toml' | 'md' }> = {
	'json-embedded': { label: 'json', cls: 'json' },
	toml: { label: 'toml', cls: 'toml' },
	'md-yaml': { label: 'md', cls: 'md' },
};
// Longer human label for the detail-pane Identity grid.
const FORMAT_LABEL: Record<ConfigFormat, string> = {
	'json-embedded': 'JSON (settings-embedded)',
	toml: 'TOML',
	'md-yaml': 'Markdown + YAML frontmatter',
};

const ANALYZE: ReadonlySet<NgwaSurfaceId> = new Set<NgwaSurfaceId>([
	'graph',
	'map',
	'life',
	'health',
	'flow',
]);

const ANALYZE_LABEL: Record<string, string> = {
	graph: 'Capability graph',
	map: 'Store map',
	life: 'Hook lifecycle',
	health: 'Inventory & health',
	flow: 'Orchestration flow',
};

// ─── Unified item model ─────────────────────────────────────────────────────
// Browse + Registry render off one normalized shape derived from the on-disk
// scan (ClaudeConfig) enriched with store-catalog membership.

export type ItemState = 'enabled' | 'disabled' | 'local' | 'orphaned';
type ItemMech = 'link' | 'merge';

export interface NgwaItem {
	id: string;
	storeKind: ClaudeStoreKind; // skill | agent | command | hook | mcp
	uiKind: NgwaKindId; // skills | agents | …
	name: string;
	scope: 'personal' | 'project';
	scopeKey: ClaudeStoreScope; // 'workspace' | `project:<id>`
	scopeLabel: string;
	projectRoot: string | null;
	path: string;
	description: string | null;
	state: ItemState;
	mech: ItemMech;
	overriddenBy: string | null;
	// ── Ngwa Phase-2 cross-system (WP-20) ──
	/** Owning engine. Absent on the scan ⇒ `"claude"`. */
	system: NgwaSystemId;
	/** On-disk serialization format (drives the row format chip). */
	format: ConfigFormat | null;
	/** Live vs. deprecated. Absent on the scan ⇒ `"active"`. */
	status: KindStatus;
	/** Source object for the detail superset. */
	raw: ClaudeAgent | ClaudeSkill | ClaudeCommand | ClaudeHook | ClaudeMcp;
	/** Store catalog row if this primitive is in the store. */
	storeEntry: ClaudeStoreEntry | null;
}

const UI_KIND_OF: Record<ClaudeStoreKind, NgwaKindId> = {
	skill: 'skills',
	agent: 'agents',
	command: 'commands',
	hook: 'hooks',
	mcp: 'mcps',
};

const KIND_LABEL: Record<NgwaKindId, string> = {
	skills: 'Skills',
	agents: 'Agents',
	commands: 'Commands',
	hooks: 'Hooks',
	mcps: 'MCP',
	store: 'Ọba · store',
};
const KIND_ABBR: Record<NgwaKindId, string> = {
	skills: 'skill',
	agents: 'agent',
	commands: 'cmd',
	hooks: 'hook',
	mcps: 'mcp',
	store: 'store',
};
const STATE_WORD: Record<ItemState, string> = {
	enabled: 'Enabled',
	disabled: 'Disabled',
	local: 'Local',
	orphaned: 'Orphaned',
};

const normRoot = (p: string) => p.replace(/\/+$/, '');
const baseOf = (p: string) => normRoot(p).split('/').filter(Boolean).pop() ?? '';

/** Resolve a project root path to the real DB project **id** — the slug the Rust
 *  store resolves via `get_project(id)` (`commands/claude_store.rs`), which is set
 *  independently from `root_path` and is NOT generally the directory basename.
 *  Matches by normalized `root_path` first, then by basename (covers `~` vs
 *  absolute divergence between `claudeProjectRoots` and `projects.root_path`).
 *  Returns null when no project row matches, so callers fall back to the basename
 *  surrogate — preserving prior behavior for unmapped roots. */
export function projectIdForRoot(projects: Project[], root: string | null): string | null {
	if (!root) return null;
	const r = normRoot(root);
	const exact = projects.find((p) => p.root_path && normRoot(p.root_path) === r);
	if (exact) return exact.id;
	const rb = baseOf(root);
	const byBase = projects.find((p) => p.root_path && baseOf(p.root_path) === rb);
	return byBase?.id ?? null;
}

// Map a scanned `ClaudeConfigScope` + projectRoot onto the store-scope grammar.
// The project scope key MUST be the DB project id (a slug), not the basename —
// the backend resolves `project:<id>` via `get_project`, so a basename surrogate
// errors `no project with id "<basename>"` whenever slug != basename.
function scopeKeyOf(
	scope: 'personal' | 'project',
	projectRoot: string | null,
	projects: Project[]
): ClaudeStoreScope {
	if (scope === 'personal') return 'workspace';
	const id = projectIdForRoot(projects, projectRoot) ?? baseOf(projectRoot ?? '') ?? 'project';
	return `project:${id || 'project'}`;
}

function scopeLabelOf(scope: 'personal' | 'project', projectRoot: string | null): string {
	if (scope === 'personal') return 'Personal';
	return (projectRoot ?? 'project').split('/').filter(Boolean).pop() ?? 'project';
}

/** Derive the lifecycle state of a scanned, file-based primitive. JSON-merge
 *  kinds (hook/mcp) are always "enabled" while present (their presence in the
 *  scan == merged into settings). */
function deriveState(meta: { isSymlink: boolean; inStore: boolean }, mech: ItemMech): ItemState {
	if (mech === 'merge') return 'enabled';
	if (meta.isSymlink && meta.inStore) return 'enabled';
	if (meta.isSymlink && !meta.inStore) return 'orphaned'; // dangling link
	return 'local'; // a real file, not store-backed
}

export function buildItems(
	config: ClaudeConfig,
	store: ClaudeStoreEntry[],
	projects: Project[]
): NgwaItem[] {
	const out: NgwaItem[] = [];
	const storeByKey = new Map<string, ClaudeStoreEntry>();
	for (const e of store) storeByKey.set(`${e.kind}:${e.name}`, e);
	// Disambiguate ids that would otherwise collide — e.g. one hook command
	// bound to several events shares kind:name:scope:root. Keeps React keys +
	// selection identity unique without changing the id for unique items.
	const seen = new Map<string, number>();

	const push = (
		storeKind: ClaudeStoreKind,
		name: string,
		scope: 'personal' | 'project',
		projectRoot: string | null,
		path: string,
		description: string | null,
		mech: ItemMech,
		meta: { isSymlink: boolean; inStore: boolean },
		overriddenBy: string | null,
		raw: NgwaItem['raw']
	) => {
		const scopeKey = scopeKeyOf(scope, projectRoot, projects);
		const storeEntry = storeByKey.get(`${storeKind}:${name}`) ?? null;
		const system = systemOf(raw);
		// Identity keys on engine too: the cross-engine `reviewer` (gemini-md +
		// codex-toml) is two distinct primitives, so `system` must be in the id.
		let id = `${system}:${storeKind}:${name}:${scope}:${projectRoot ?? ''}`;
		const dup = seen.get(id) ?? 0;
		seen.set(id, dup + 1);
		if (dup > 0) id = `${id}#${dup}`;
		out.push({
			id,
			storeKind,
			uiKind: UI_KIND_OF[storeKind],
			name,
			scope,
			scopeKey,
			scopeLabel: scopeLabelOf(scope, projectRoot),
			projectRoot,
			path,
			description,
			state: deriveState(meta, mech),
			mech,
			overriddenBy,
			system,
			format: raw.format ?? null,
			status: statusOf(raw),
			raw,
			storeEntry,
		});
	};

	for (const a of config.agents)
		push(
			'agent',
			a.name,
			a.scope,
			a.projectRoot,
			a.path,
			a.description,
			'link',
			a,
			a.overriddenBy,
			a
		);
	for (const s of config.skills)
		push(
			'skill',
			s.name,
			s.scope,
			s.projectRoot,
			s.path,
			s.description,
			'link',
			s,
			s.overriddenBy,
			s
		);
	for (const c of config.commands)
		push(
			'command',
			c.name,
			c.scope,
			c.projectRoot,
			c.path,
			c.description,
			'link',
			c,
			c.overriddenBy,
			c
		);
	for (const h of config.hooks)
		push(
			'hook',
			h.name,
			h.scope,
			h.projectRoot,
			h.settingsPath,
			h.event,
			'merge',
			{ isSymlink: false, inStore: false },
			null,
			h
		);
	for (const m of config.mcps)
		push(
			'mcp',
			m.name,
			m.scope,
			m.projectRoot,
			m.path,
			`${m.transport} server`,
			'merge',
			{ isSymlink: false, inStore: false },
			null,
			m
		);

	return out;
}

// ─── System-facet summary (shared sidebar ↔ surface) ────────────────────────
// Engines present in the scan (preserving CL→GM→CX order), the per-engine total
// count, and the per-kind count aggregated across the *active* (toggled-on)
// systems. The sidebar consumes `present` + `engineCounts` to render the SYSTEM
// facet, and `kindCounts(active)` to show Kind counts summed over active
// engines (D-08 point 4).

export interface NgwaSystemSummary {
	/** Engines present in the scan, in canonical CL→GM→CX order. */
	present: NgwaSystemId[];
	/** Total primitive count per present engine. */
	engineCounts: Record<NgwaSystemId, number>;
	/** Per-kind counts, summed over a supplied set of active engines. */
	kindCounts: (active: ReadonlySet<NgwaSystemId>) => Record<NgwaKindId, number>;
}

export function summarizeSystems(items: NgwaItem[]): NgwaSystemSummary {
	const engineCounts = { claude: 0, gemini: 0, codex: 0 } as Record<NgwaSystemId, number>;
	for (const it of items) engineCounts[it.system] = (engineCounts[it.system] ?? 0) + 1;
	const present = ENGINE_ORDER.filter((e) => engineCounts[e] > 0);
	const kindCounts = (active: ReadonlySet<NgwaSystemId>): Record<NgwaKindId, number> => {
		const c: Record<NgwaKindId, number> = {
			skills: 0,
			agents: 0,
			commands: 0,
			hooks: 0,
			mcps: 0,
			store: 0,
		};
		for (const it of items) {
			if (active.has(it.system)) c[it.uiKind] += 1;
		}
		return c;
	};
	return { present, engineCounts, kindCounts };
}

/** Other engines (besides the item's own) that carry a primitive of the same
 *  kind+name — the cross-engine collision the detail pane surfaces. Returns them
 *  in canonical CL→GM→CX order, de-duplicated. */
export function siblingSystemsOf(item: NgwaItem | null, items: NgwaItem[]): NgwaSystemId[] {
	if (!item) return [];
	const others = new Set<NgwaSystemId>();
	for (const x of items) {
		if (x.storeKind === item.storeKind && x.name === item.name && x.system !== item.system) {
			others.add(x.system);
		}
	}
	return ENGINE_ORDER.filter((e) => others.has(e));
}

/** Resolve the effective active-system set from the URL `sys` selection and the
 *  engines actually present. An empty / absent selection ⇒ all present engines
 *  on (D-08 default). Selections are intersected with `present` so a stale id
 *  can't leave the list empty. */
export function resolveActiveSystems(
	selected: readonly NgwaSystemId[] | null,
	present: readonly NgwaSystemId[]
): Set<NgwaSystemId> {
	const presentSet = new Set(present);
	if (!selected || selected.length === 0) return new Set(present);
	const picked = selected.filter((s) => presentSet.has(s));
	return picked.length > 0 ? new Set(picked) : new Set(present);
}

// ─── Top-level surface ──────────────────────────────────────────────────────

interface NgwaSurfaceProps {
	config: ClaudeConfig | null;
	isLoading: boolean;
	error: string | null;
	surface: NgwaSurfaceId;
	scope: NgwaScopeId;
	kind: NgwaKindId;
	/** Selected systems from the URL `sys` param. Empty/absent ⇒ all present. */
	systems: NgwaSystemId[];
	onEdit: (path: string) => void;
	/** Available project scopes to offer in move/copy/install pickers. */
	projectScopes: Array<{ key: ClaudeStoreScope; label: string }>;
	/** DB project rows — used to map a scanned project root to its real store id. */
	projects: Project[];
}

export function NgwaSurface({
	config,
	isLoading,
	error,
	surface,
	scope,
	kind,
	systems,
	onEdit,
	projectScopes,
	projects,
}: NgwaSurfaceProps) {
	const storeQuery = useQuery(claudeStoreQueryOptions(null));
	const store = storeQuery.data ?? [];

	const items = useMemo(
		() => (config ? buildItems(config, store, projects) : []),
		[config, store, projects]
	);

	// SYSTEM facet — engines present + the active (toggled-on) subset. The active
	// set drives both the engine-grouped Browse rows and the aggregated counts.
	const summary = useMemo(() => summarizeSystems(items), [items]);
	const activeSystems = useMemo(
		() => resolveActiveSystems(systems, summary.present),
		[systems, summary.present]
	);

	const counts = useMemo(() => {
		const c: Record<string, number> = {
			...summary.kindCounts(activeSystems),
		};
		c.store = store.length;
		return c;
	}, [summary, activeSystems, store]);

	// Total reflects the active systems too, so the header count tracks the facet.
	const total = useMemo(
		() => items.reduce((n, it) => (activeSystems.has(it.system) ? n + 1 : n), 0),
		[items, activeSystems]
	);

	// Mode toggle reflects the URL surface but also lets the user flip in-place
	// (Browse ⇄ Registry) without a sidebar round-trip — we keep a local mode
	// seeded from the URL surface (G-02).
	const [mode, setMode] = useState<'browse' | 'registry'>(
		surface === 'registry' ? 'registry' : 'browse'
	);
	useEffect(() => {
		if (surface === 'browse' || surface === 'registry') setMode(surface);
	}, [surface]);

	const isAnalyze = ANALYZE.has(surface);

	return (
		<div className="ccfg ngwa-fill" style={{ gridTemplateRows: 'auto 1fr auto' }}>
			<div className="ngwa-hd">
				<div className="ttl">
					<h1>
						<span className="glyph">⌗</span> Ngwa
					</h1>
					<span className="ct">{total} entries</span>
					<span className="sub">
						{isAnalyze
							? ANALYZE_LABEL[surface]
							: mode === 'registry'
								? 'one registry · all primitives · all scopes · bulk triage'
								: 'agents · skills · commands · hooks · MCP, across scopes'}
					</span>
				</div>
				<div className="hd-right">
					{!isAnalyze && (
						<div
							className="ngwa-mode"
							title="Browse = per-kind depth · Registry = cross-kind triage + bulk"
						>
							<button
								type="button"
								className={cn(mode === 'browse' && 'on')}
								onClick={() => setMode('browse')}
							>
								<LayoutGrid /> Browse
							</button>
							<button
								type="button"
								className={cn(mode === 'registry' && 'on')}
								onClick={() => setMode('registry')}
							>
								<ListIcon /> Registry
							</button>
						</div>
					)}
					{/* engine seam — live badge set of the active systems (D-08). The
					    SYSTEM facet in the sidebar is the toggle; this is a read-only
					    indicator of which engines are currently in view. */}
					{summary.present.length > 1 && (
						<div
							className="ngwa-sysset"
							title="Systems in view — toggle in the sidebar SYSTEM facet"
						>
							{summary.present.map((e) => (
								<span
									key={e}
									className={cn('ngwa-eb', ENGINE_META[e].code, !activeSystems.has(e) && 'off')}
									title={ENGINE_META[e].display}
								>
									<EngineGlyph system={e} />
								</span>
							))}
						</div>
					)}
				</div>
			</div>

			{isAnalyze ? (
				<AnalyzeSurface
					surface={surface}
					config={config}
					scope={scope}
					items={items}
					store={store}
				/>
			) : mode === 'registry' ? (
				<RegistrySurface
					items={items}
					store={store}
					scope={scope}
					activeSystems={activeSystems}
					present={summary.present}
					isLoading={isLoading || storeQuery.isLoading}
					error={error}
					onEdit={onEdit}
					projectScopes={projectScopes}
				/>
			) : (
				<BrowseSurface
					items={items}
					store={store}
					scope={scope}
					kind={kind}
					counts={counts}
					activeSystems={activeSystems}
					present={summary.present}
					isLoading={isLoading || storeQuery.isLoading}
					error={error}
					onEdit={onEdit}
					projectScopes={projectScopes}
				/>
			)}

			<Legend />
		</div>
	);
}

function Legend() {
	return (
		<div className="ngwa-legend">
			<span>
				<i className="ngwa-dot enabled" /> enabled
			</span>
			<span>
				<i className="ngwa-dot disabled" /> disabled
			</span>
			<span>
				<i className="ngwa-dot local" /> local · not in store
			</span>
			<span>
				<i className="ngwa-dot orphaned" /> orphaned
			</span>
			<span style={{ marginLeft: 'auto' }}>
				<i className="ngwa-mtag link">link</i> symlink → store
			</span>
			<span>
				<i className="ngwa-mtag merge">merge</i> JSON-spliced into settings
			</span>
			<span>
				<i className="ngwa-ovr">ovr</i> shadowed by higher scope
			</span>
		</div>
	);
}

// ─── Scope filtering shared by both surfaces ────────────────────────────────
function passScope(it: NgwaItem, scope: NgwaScopeId): boolean {
	if (scope === 'all') return true;
	if (scope === 'personal') return it.scope === 'personal';
	// `project:<id>` — narrow to the one project this item belongs to.
	return it.scopeKey === scope;
}

// ─── BROWSE surface (2-pane: list │ resizable divider │ detail) ─────────────

interface BrowseProps {
	items: NgwaItem[];
	store: ClaudeStoreEntry[];
	scope: NgwaScopeId;
	kind: NgwaKindId;
	counts: Record<string, number>;
	activeSystems: ReadonlySet<NgwaSystemId>;
	present: NgwaSystemId[];
	isLoading: boolean;
	error: string | null;
	onEdit: (path: string) => void;
	projectScopes: Array<{ key: ClaudeStoreScope; label: string }>;
}

function BrowseSurface({
	items,
	store,
	scope,
	kind,
	activeSystems,
	present,
	isLoading,
	error,
	onEdit,
	projectScopes,
}: BrowseProps) {
	const [filter, setFilter] = useState('');
	const [selId, setSelId] = useState<string | null>(null);

	const splitRef = useRef<HTMLDivElement | null>(null);
	const dividerRef = useRef<HTMLDivElement | null>(null);

	// G-06: drag-to-resize divider + double-click reset.
	useEffect(() => {
		const split = splitRef.current;
		const divider = dividerRef.current;
		if (!split || !divider) return;
		function onDown(e: MouseEvent) {
			if (!split) return;
			e.preventDefault();
			const rect = split.getBoundingClientRect();
			const startX = e.clientX;
			const startListW =
				(split.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 300;
			function onMove(ev: MouseEvent) {
				if (!split) return;
				const delta = ev.clientX - startX;
				let next = startListW + delta;
				const max = rect.width - 360 - 4;
				if (next < 220) next = 220;
				if (next > max) next = max;
				split.style.setProperty('--list-w', `${next}px`);
			}
			function onUp() {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
			}
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		}
		function onDouble() {
			split?.style.removeProperty('--list-w');
		}
		divider.addEventListener('mousedown', onDown);
		divider.addEventListener('dblclick', onDouble);
		return () => {
			divider.removeEventListener('mousedown', onDown);
			divider.removeEventListener('dblclick', onDouble);
		};
	}, []);

	// Store-catalog kind shows the interactive catalog (G-09), otherwise scope+kind
	// filtered on-disk items.
	const isStoreKind = kind === 'store';

	const list = useMemo(() => {
		if (isStoreKind) return [];
		const storeKind = (Object.keys(UI_KIND_OF) as ClaudeStoreKind[]).find(
			(k) => UI_KIND_OF[k] === kind
		);
		let xs = items.filter(
			(it) => it.uiKind === kind && passScope(it, scope) && activeSystems.has(it.system)
		);
		if (storeKind) void storeKind; // kind already mapped via uiKind
		if (filter.trim()) {
			const f = filter.toLowerCase();
			xs = xs.filter(
				(it) =>
					it.name.toLowerCase().includes(f) || (it.description ?? '').toLowerCase().includes(f)
			);
		}
		return xs;
	}, [items, kind, scope, filter, isStoreKind, activeSystems]);

	const storeList = useMemo(() => {
		if (!isStoreKind) return [];
		let xs = store;
		if (filter.trim()) {
			const f = filter.toLowerCase();
			xs = xs.filter(
				(e) => e.name.toLowerCase().includes(f) || (e.description ?? '').toLowerCase().includes(f)
			);
		}
		return xs;
	}, [store, isStoreKind, filter]);

	const selected = useMemo(() => {
		if (isStoreKind) return null;
		if (!list.length) return null;
		return list.find((it) => it.id === selId) ?? list[0];
	}, [list, selId, isStoreKind]);

	const selectedStore = useMemo(() => {
		if (!isStoreKind) return null;
		if (!storeList.length) return null;
		return storeList.find((e) => `store:${e.kind}:${e.name}` === selId) ?? storeList[0];
	}, [storeList, selId, isStoreKind]);

	// Engine-grouped clusters (D-08): rows cluster under a tinted per-engine
	// sub-header rather than interleaving. Only emitted when more than one engine
	// is active — a single active engine collapses to the flat list so the
	// Claude-only view is byte-identical to today (regression guard).
	const engineGroups = useMemo<Array<{ system: NgwaSystemId; items: NgwaItem[] }> | null>(() => {
		const activeCount = present.filter((e) => activeSystems.has(e)).length;
		if (activeCount <= 1) return null;
		const by = new Map<NgwaSystemId, NgwaItem[]>();
		for (const it of list) {
			if (!by.has(it.system)) by.set(it.system, []);
			by.get(it.system)!.push(it);
		}
		// Stable CL→GM→CX order; only engines that actually have rows.
		return ENGINE_ORDER.filter((e) => by.has(e)).map((e) => ({ system: e, items: by.get(e)! }));
	}, [list, present, activeSystems]);

	// A short path hint for an engine sub-header, derived from the first row's
	// on-disk path (e.g. `.gemini/agents`). Falls back to the engine display.
	function enginePathHint(its: NgwaItem[]): string {
		const p = its[0]?.path ?? '';
		const m = p.match(/(\.(?:claude|gemini|codex)\/[a-z]+)/);
		return m ? m[1] : ENGINE_META[its[0]?.system ?? 'claude'].display;
	}

	return (
		<div className="ccfg-split" ref={splitRef} style={{ minHeight: 0 }}>
			<div className="ccfg-list">
				<div className="ccfg-list-toolbar">
					<div className="ccfg-search-wrap">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<circle cx="11" cy="11" r="7" />
							<path d="m20 20-3-3" />
						</svg>
						<input
							className="ccfg-search"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="filter…"
						/>
					</div>
				</div>
				<div className="ccfg-list-meta">
					<span>{isStoreKind ? 'STORE / CATALOG' : KIND_LABEL[kind].toUpperCase()}</span>
					<span>
						{scope === 'all' ? 'all scopes' : scope.startsWith('project:') ? scope.slice(8) : scope}{' '}
						· {isStoreKind ? `${storeList.length} canonical` : list.length}
						{!isStoreKind && engineGroups && ` · ${engineGroups.length} systems`}
					</span>
				</div>
				<div className="ccfg-list-rows">
					{isLoading ? (
						<div className="ccfg-empty">Loading…</div>
					) : error ? (
						<div className="ccfg-empty">{error}</div>
					) : isStoreKind ? (
						storeList.length === 0 ? (
							<div className="ccfg-empty">No catalog entries match.</div>
						) : (
							storeList.map((e) => (
								<StoreRow
									key={`store:${e.kind}:${e.name}`}
									entry={e}
									active={
										selectedStore != null &&
										selectedStore.name === e.name &&
										selectedStore.kind === e.kind
									}
									onClick={() => setSelId(`store:${e.kind}:${e.name}`)}
								/>
							))
						)
					) : list.length === 0 ? (
						<div className="ccfg-empty">No entries match.</div>
					) : engineGroups ? (
						engineGroups.map(({ system, items: its }) => (
							<div key={system}>
								<div className={cn('ccfg-engine-head', ENGINE_META[system].code)}>
									<span className="eg" aria-hidden>
										<EngineGlyph system={system} />
									</span>
									<span className="hn">
										{ENGINE_META[system].display} · {its.length}
									</span>
									<span className="ct">{enginePathHint(its)}</span>
								</div>
								{its.map((it) => (
									<BrowseRow
										key={it.id}
										item={it}
										active={!!selected && selected.id === it.id}
										onClick={() => setSelId(it.id)}
										showEngineMeta
									/>
								))}
							</div>
						))
					) : (
						list.map((it) => (
							<BrowseRow
								key={it.id}
								item={it}
								active={!!selected && selected.id === it.id}
								onClick={() => setSelId(it.id)}
							/>
						))
					)}
				</div>
			</div>
			<div className="ccfg-divider" ref={dividerRef} />
			<div className="ccfg-detail ngwa-detail">
				{isStoreKind ? (
					selectedStore ? (
						<StoreDetail entry={selectedStore} projectScopes={projectScopes} onEdit={onEdit} />
					) : (
						<EmptyCarve />
					)
				) : selected ? (
					<ItemDetail
						item={selected}
						projectScopes={projectScopes}
						onEdit={onEdit}
						siblingSystems={siblingSystemsOf(selected, items)}
						present={present}
					/>
				) : (
					<EmptyCarve />
				)}
			</div>
		</div>
	);
}

function EmptyCarve() {
	return (
		<div className="ccfg-empty">
			<div className="carve">▽▽▽</div>
			Select an entry to inspect its contents,
			<br />
			relationships, and precedence.
		</div>
	);
}

function StateDot({ state }: { state: ItemState }) {
	return <span className={cn('ngwa-dot', state)} title={STATE_WORD[state]} aria-hidden />;
}

function FormatChip({ format }: { format: ConfigFormat | null }) {
	if (!format) return null;
	const f = FORMAT_CHIP[format];
	return <span className={cn('ccfg-fmt', f.cls)}>{f.label}</span>;
}

function BrowseRow({
	item,
	active,
	onClick,
	showEngineMeta = false,
}: {
	item: NgwaItem;
	active: boolean;
	onClick: () => void;
	/** Multi-engine (facet) mode: show the per-row format chip + deprecated chip.
	 *  Off in the Claude-only view so it renders byte-identical to today. */
	showEngineMeta?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'ccfg-row text-left w-full',
				active && 'is-on',
				item.overriddenBy && 'is-shadowed'
			)}
		>
			<div className="ccfg-row-name">
				<StateDot state={item.state} />
				<span>{item.name}</span>
				{showEngineMeta && <FormatChip format={item.format} />}
				<span className={cn('ccfg-scope', item.scope === 'personal' && 'is-personal')}>
					{item.scope === 'personal' ? 'pers' : item.scopeLabel}
				</span>
				{item.overriddenBy && (
					<span className="ngwa-ovr" title={`Overridden by a ${item.overriddenBy} entry`}>
						ovr
					</span>
				)}
			</div>
			{item.description && <div className="ccfg-row-desc">{item.description}</div>}
			<div className="ccfg-row-meta">
				{/* G-11: state WORD in every row, not colour-only */}
				<span className={cn('ngwa-stword', item.state)}>{STATE_WORD[item.state]}</span>
				{showEngineMeta && item.status === 'deprecated' && (
					<>
						<span>·</span>
						<span className="ngwa-stword deprecated">deprecated</span>
					</>
				)}
				<span>·</span>
				<span>
					{item.storeEntry ? 'store ↗' : item.scope === 'personal' ? '~/.claude' : '.claude'}
				</span>
				<span className={cn('ngwa-mtag', item.mech)}>{item.mech}</span>
			</div>
		</button>
	);
}

function StoreRow({
	entry,
	active,
	onClick,
}: {
	entry: ClaudeStoreEntry;
	active: boolean;
	onClick: () => void;
}) {
	const enabledCount = entry.enabledIn.length;
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn('ccfg-row text-left w-full', active && 'is-on')}
		>
			<div className="ccfg-row-name">
				<StateDot state={enabledCount ? 'enabled' : 'disabled'} />
				<span>{entry.name}</span>
				<span className="ccfg-scope">{KIND_ABBR[UI_KIND_OF[entry.kind]]}</span>
			</div>
			{entry.description && <div className="ccfg-row-desc">{entry.description}</div>}
			<div className="ccfg-row-meta">
				<span className={cn('ngwa-stword', enabledCount ? 'enabled' : 'disabled')}>
					{enabledCount ? `Enabled in ${enabledCount}` : 'Available'}
				</span>
				<span>·</span>
				<span>canonical</span>
			</div>
		</button>
	);
}

// ─── REGISTRY surface (full-width 8-col table + @filter DSL + bulk) ─────────

interface RegistryProps {
	items: NgwaItem[];
	store: ClaudeStoreEntry[];
	scope: NgwaScopeId;
	activeSystems: ReadonlySet<NgwaSystemId>;
	present: NgwaSystemId[];
	isLoading: boolean;
	error: string | null;
	onEdit: (path: string) => void;
	projectScopes: Array<{ key: ClaudeStoreScope; label: string }>;
}

const FCHIPS = ['@personal', '@project', '@disabled', '@orphaned', '@local'] as const;

function RegistrySurface({
	items,
	scope,
	activeSystems,
	present,
	isLoading,
	error,
	onEdit,
	projectScopes,
}: RegistryProps) {
	const [q, setQ] = useState('');
	const [chips, setChips] = useState<Set<string>>(new Set());
	const [multi, setMulti] = useState<Set<string>>(new Set());
	const [drawerId, setDrawerId] = useState<string | null>(null);

	const enable = useEnablePrimitive();
	const disable = useDisablePrimitive();

	// @filter DSL: chips + inline `@token`s in the query. Free words match
	// name/description; recognised `@token`s narrow scope/state/kind.
	function pass(it: NgwaItem): boolean {
		if (!passScope(it, scope)) return false;
		if (!activeSystems.has(it.system)) return false;
		for (const f of chips) {
			if (!matchToken(it, f.slice(1))) return false;
		}
		for (const t of q.toLowerCase().trim().split(/\s+/).filter(Boolean)) {
			if (t[0] === '@') {
				if (!matchToken(it, t.slice(1))) return false;
			} else if (
				!it.name.toLowerCase().includes(t) &&
				!(it.description ?? '').toLowerCase().includes(t)
			) {
				return false;
			}
		}
		return true;
	}

	const rows = useMemo(
		() => items.filter(pass),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[items, scope, chips, q, activeSystems]
	);

	const drawerItem = useMemo(
		() => (drawerId ? (items.find((it) => it.id === drawerId) ?? null) : null),
		[drawerId, items]
	);

	const allChecked = rows.length > 0 && rows.every((it) => multi.has(it.id));

	function toggleAll() {
		setMulti(() => (allChecked ? new Set() : new Set(rows.map((it) => it.id))));
	}

	function toggleRowSel(id: string) {
		setMulti((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}

	function toggleEnabled(it: NgwaItem) {
		if (it.state === 'enabled') {
			disable.mutate({ kind: it.storeKind, name: it.name, scope: it.scopeKey });
		} else if (it.state === 'disabled') {
			enable.mutate({ kind: it.storeKind, name: it.name, scope: it.scopeKey });
		}
	}

	function bulk(action: 'enable' | 'disable') {
		for (const id of multi) {
			const it = items.find((x) => x.id === id);
			if (!it) continue;
			if (action === 'enable')
				enable.mutate({ kind: it.storeKind, name: it.name, scope: it.scopeKey });
			else disable.mutate({ kind: it.storeKind, name: it.name, scope: it.scopeKey });
		}
		setMulti(new Set());
	}

	return (
		<div className="ngwa-registry">
			<div className="ngwa-toolbar">
				<div className="ccfg-search-wrap">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3-3" />
					</svg>
					<input
						className="ccfg-search"
						style={{ fontFamily: 'var(--font-mono)' }}
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="filter…  try @disabled @personal @orphaned @mcp"
					/>
				</div>
				{FCHIPS.map((f) => (
					<button
						key={f}
						type="button"
						className={cn('ngwa-fchip', chips.has(f) && 'on')}
						onClick={() =>
							setChips((prev) => {
								const next = new Set(prev);
								next.has(f) ? next.delete(f) : next.add(f);
								return next;
							})
						}
					>
						{f}
					</button>
				))}
			</div>

			<div className="ngwa-tablewrap">
				<table className="ngwa-table">
					<thead>
						<tr>
							<th style={{ width: 28 }}>
								<input
									type="checkbox"
									checked={allChecked}
									onChange={toggleAll}
									aria-label="Select all"
								/>
							</th>
							<th>Kind</th>
							<th>Name</th>
							<th>Scope</th>
							<th>State</th>
							<th>Source</th>
							<th>Mech</th>
							<th style={{ textAlign: 'right' }}>Actions</th>
						</tr>
					</thead>
					<tbody>
						{isLoading ? (
							<tr>
								<td colSpan={8} style={cellCenter}>
									Loading…
								</td>
							</tr>
						) : error ? (
							<tr>
								<td colSpan={8} style={cellCenter}>
									{error}
								</td>
							</tr>
						) : rows.length === 0 ? (
							<tr>
								<td colSpan={8} style={cellCenter}>
									no matches for this filter
								</td>
							</tr>
						) : (
							rows.map((it) => (
								<tr
									key={it.id}
									className={cn(
										it.state === 'disabled' && 'dis',
										it.overriddenBy && 'is-shadowed',
										drawerId === it.id && 'on'
									)}
									onClick={(e) => {
										if ((e.target as HTMLElement).closest('input,.ngwa-swc,.ngwa-iact')) return;
										setDrawerId(it.id);
									}}
								>
									<td>
										<input
											type="checkbox"
											checked={multi.has(it.id)}
											onChange={() => toggleRowSel(it.id)}
											aria-label={`Select ${it.name}`}
										/>
									</td>
									<td>
										<span className="ngwa-kb">{KIND_ABBR[it.uiKind]}</span>
									</td>
									<td>
										<div className="nm">
											{it.name}
											{it.overriddenBy && <span className="ngwa-ovr">ovr</span>}
										</div>
										{it.description && <div className="desc">{it.description}</div>}
									</td>
									<td>
										<span className={cn('ccfg-scope', it.scope === 'personal' && 'is-personal')}>
											{it.scope === 'personal' ? 'pers' : it.scopeLabel}
										</span>
									</td>
									<td>
										<span className="st">
											<StateDot state={it.state} />
											<span className={cn('ngwa-stword', it.state)}>{STATE_WORD[it.state]}</span>
										</span>
									</td>
									<td>
										<span className="src">
											{it.storeEntry
												? 'store ↗'
												: it.scope === 'personal'
													? '~/.claude'
													: '.claude'}
										</span>
									</td>
									<td>
										<span className={cn('ngwa-mtag', it.mech)}>{it.mech}</span>
									</td>
									<td>
										<div className="ngwa-rowacts">
											{(it.state === 'enabled' || it.state === 'disabled') && (
												<span
													className={cn('ngwa-swc', it.state === 'enabled' && 'on')}
													title="toggle enable"
													role="button"
													tabIndex={0}
													onClick={(e) => {
														e.stopPropagation();
														toggleEnabled(it);
													}}
												/>
											)}
											<button
												type="button"
												className="ngwa-iact"
												onClick={(e) => {
													e.stopPropagation();
													setDrawerId(it.id);
												}}
											>
												inspect
											</button>
										</div>
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			{multi.size > 0 && (
				<div className="ngwa-bulk">
					<span className="cnt">
						<b>{multi.size}</b> selected
					</span>
					<button type="button" className="ngwa-bbtn" onClick={() => bulk('enable')}>
						Enable
					</button>
					<button type="button" className="ngwa-bbtn" onClick={() => bulk('disable')}>
						Disable
					</button>
					<button type="button" className="ngwa-bbtn warn" onClick={() => bulk('disable')}>
						Remove
					</button>
					<button
						type="button"
						className="ngwa-bbtn"
						style={{ marginLeft: 'auto' }}
						onClick={() => setMulti(new Set())}
					>
						Clear
					</button>
				</div>
			)}

			{/* Registry detail opens in a right drawer reusing the superset */}
			{drawerItem && (
				<div
					className="ngwa-scrim"
					onClick={(e) => e.target === e.currentTarget && setDrawerId(null)}
				>
					<div
						className="ngwa-modal"
						style={{ width: 420, maxHeight: '90vh', overflow: 'auto', padding: 0 }}
						onClick={(e) => e.stopPropagation()}
					>
						<ItemDetail
							item={drawerItem}
							projectScopes={projectScopes}
							onEdit={onEdit}
							siblingSystems={siblingSystemsOf(drawerItem, items)}
							present={present}
						/>
						<div style={{ padding: 'var(--space-3)', textAlign: 'right' }}>
							<button type="button" className="ngwa-btn" onClick={() => setDrawerId(null)}>
								Close
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

const cellCenter: React.CSSProperties = {
	padding: 30,
	textAlign: 'center',
	color: 'var(--fg-faint)',
	fontFamily: 'var(--font-mono)',
	fontSize: 11,
};

function matchToken(it: NgwaItem, w: string): boolean {
	switch (w) {
		case 'personal':
			return it.scope === 'personal';
		case 'project':
			return it.scope === 'project';
		case 'disabled':
			return it.state === 'disabled';
		case 'orphaned':
			return it.state === 'orphaned';
		case 'local':
			return it.state === 'local';
		case 'enabled':
			return it.state === 'enabled';
		default:
			// kind token (skill/agent/cmd/hook/mcp or the ui plural)
			return KIND_ABBR[it.uiKind] === w || it.uiKind.startsWith(w) || it.storeKind === w;
	}
}

// ─── Superset DETAIL (G-01 body · G-03 tree · G-04 precedence · G-07 chips) ─

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string');
}
function partitionTools(allowed: readonly string[]): { tools: string[]; mcp: string[] } {
	const tools: string[] = [];
	const mcp: string[] = [];
	for (const t of allowed) (t.startsWith('mcp__') ? mcp : tools).push(t);
	return { tools, mcp };
}
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Section({
	label,
	count,
	children,
}: {
	label: string;
	count?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="ccfg-section">
			<div className="ccfg-section-label">
				<span>{label}</span>
				{count && <span className="ct">{count}</span>}
			</div>
			{children}
		</div>
	);
}

function ItemDetail({
	item,
	projectScopes,
	onEdit,
	siblingSystems = [],
	present = ['claude'],
}: {
	item: NgwaItem;
	projectScopes: Array<{ key: ClaudeStoreScope; label: string }>;
	onEdit: (path: string) => void;
	/** Other engines that have a primitive of the same kind+name (cross-engine
	 *  collision, e.g. the `reviewer` agent under Gemini + Codex). */
	siblingSystems?: NgwaSystemId[];
	/** Engines present in the scan — drives the D-09 cross-engine destination set.
	 *  Defaults to Claude-only so single-engine views behave exactly as before. */
	present?: NgwaSystemId[];
}) {
	const enable = useEnablePrimitive();
	const disable = useDisablePrimitive();
	const move = useMovePrimitive();
	const copy = useCopyPrimitive();
	const remove = useRemovePrimitive();
	const importToStore = useImportToStore();

	const [picker, setPicker] = useState<null | 'move' | 'copy'>(null);
	// D-09: the cross-engine multi-destination transcode drawer (file-based kinds
	// only). For hooks/mcp, "Copy to…" keeps the single-scope same-engine picker.
	const [showCopyDrawer, setShowCopyDrawer] = useState(false);
	const crossEngineCopyable = isCrossEngineCopyable(item.storeKind);
	const [scriptBody, setScriptBody] = useState<string | null>(null);

	const on = item.state === 'enabled';
	const k = item.storeKind;

	// ── precedence / override callout (G-04) ──
	let prec: React.ReactNode = null;
	if (item.overriddenBy) {
		prec = (
			<div className="ngwa-prec shadowed">
				<b>Shadowed.</b> A <b>{item.overriddenBy}</b> entry of the same name takes precedence — this
				copy is inactive when working under that scope. Orthogonal to enabled/disabled.
				<div className="chain">
					<span className="lose">{item.scopeLabel}</span> ‹{' '}
					<span className="win">{item.overriddenBy} ✓ wins</span>
				</div>
			</div>
		);
	}

	// ── mechanism callout ──
	const mech =
		item.mech === 'merge' ? (
			<div className="ngwa-mech merge">
				<b>JSON-merge.</b> This {k === 'hook' ? 'hook' : 'MCP server'} is a keyed block inside its
				settings file. Enable/disable splices only its key — every unrelated key (incl.
				session/OAuth state) is preserved. No symlink.
			</div>
		) : (
			<div className="ngwa-mech">
				<b>Symlink → store.</b> Enabling links{' '}
				<code>
					.claude/{k}s/{item.name}
				</code>{' '}
				into the central store (Ọba). Disabling drops the link; the store copy stays.
			</div>
		);

	// ── kind-specific frontmatter + chips + body ──
	const { fmRows, chips, body, tree } = detailParts(item);

	function loadScript() {
		const h = item.raw as ClaudeHook;
		if (!h.commandPath) return;
		claudeConfigReadFile(h.commandPath)
			.then(setScriptBody)
			.catch((e) => setScriptBody(String(e)));
	}

	return (
		<>
			<div className="ccfg-detail-head">
				<div className="ccfg-detail-topline">
					<button
						type="button"
						className="ccfg-filepath"
						title={`Reveal ${item.path}`}
						onClick={() => onEdit(item.path)}
					>
						{shortPath(item.path)}
					</button>
				</div>
				<h2>
					<span className={cn('ccfg-eb', ENGINE_META[item.system].code)} aria-hidden>
						<EngineGlyph system={item.system} />
					</span>
					{item.name}
					<StateDot state={item.state} />
					<span
						className={cn(
							'ccfg-scope-pill',
							item.scope === 'project' ? 'is-project' : 'is-personal'
						)}
					>
						{item.scope}
					</span>
				</h2>
				<div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
					<span className="ngwa-dstate">
						<StateDot state={item.state} /> {STATE_WORD[item.state]}
					</span>
					<span className={cn('ngwa-mtag', item.mech)}>{item.mech}</span>
					{item.format && <FormatChip format={item.format} />}
					{item.status === 'deprecated' && (
						<span className="ngwa-stword deprecated">deprecated</span>
					)}
				</div>
				{item.description && <div className="ccfg-detail-desc">{item.description}</div>}
			</div>

			<div className="ccfg-detail-body">
				{prec && <div className="ccfg-section">{prec}</div>}

				{siblingSystems.length > 0 && (
					<Section label="Same name across systems">
						<div className="ngwa-mech">
							A <b>{k}</b> named <b>{item.name}</b> also exists under{' '}
							{siblingSystems.map((s, i) => (
								<span key={s}>
									{i > 0 && ', '}
									<span className={cn('ccfg-eb', ENGINE_META[s].code)} aria-hidden>
										<EngineGlyph system={s} />
									</span>{' '}
									{ENGINE_META[s].display}
								</span>
							))}
							. Ngwa keys identity on <code>{'{system, kind, scope, name}'}</code>, so these are
							distinct primitives shown side by side.
						</div>
					</Section>
				)}

				<Section label="Identity">
					<FrontmatterGrid entries={fmRows} />
				</Section>

				{chips}

				<div className="ccfg-section">{mech}</div>

				{item.state === 'local' && (
					<div className="ccfg-section">
						<div className="ngwa-mech merge">
							<b>Not in store.</b> A real file in this scope. Import it to enable symlink-based
							reuse across projects.
						</div>
					</div>
				)}
				{item.state === 'orphaned' && (
					<div className="ccfg-section">
						<div className="ngwa-mech warn">
							<b>Orphaned.</b> The symlink target was removed from the store. Remove the dangling
							link, or re-link to a store entry.
						</div>
					</div>
				)}

				{/* G-01 / G-05: body or hook script */}
				{k === 'hook' ? (
					<Section
						label="Script"
						count={scriptBody ? `${scriptBody.split('\n').length} lines` : 'load script'}
					>
						{(item.raw as ClaudeHook).commandPath && !scriptBody && (
							<button type="button" className="ngwa-btn" onClick={loadScript}>
								Load script
							</button>
						)}
						<pre className="ccfg-script">
							{scriptBody ?? JSON.stringify((item.raw as ClaudeHook).raw, null, 2)}
						</pre>
					</Section>
				) : k === 'mcp' ? (
					<Section label="Server config">
						<pre className="ccfg-script">
							{JSON.stringify((item.raw as ClaudeMcp).raw, null, 2)}
						</pre>
					</Section>
				) : (
					<Section
						label={k === 'agent' ? 'System prompt · body' : 'Body'}
						count={`${body.split('\n').length} lines`}
					>
						<div className="ccfg-body-md">
							<Markdown content={body} density="compact" />
						</div>
					</Section>
				)}

				{/* G-03 supporting-files tree (skills) */}
				{tree}
			</div>

			{/* write actions (G-10) — pinned footer */}
			<div className="ngwa-actions">
				<div className="ngwa-acts">
					{(item.state === 'enabled' || item.state === 'disabled') && (
						<label className="ngwa-toggle">
							<span
								className={cn('ngwa-sw', on && 'on')}
								role="button"
								tabIndex={0}
								onClick={() =>
									on
										? disable.mutate({ kind: k, name: item.name, scope: item.scopeKey })
										: enable.mutate({ kind: k, name: item.name, scope: item.scopeKey })
								}
							/>
							{item.mech === 'merge' ? (on ? 'Merged in' : 'Removed') : on ? 'Enabled' : 'Disabled'}
						</label>
					)}
					{item.state === 'local' && (
						<button
							type="button"
							className="ngwa-btn primary"
							disabled={importToStore.isPending}
							onClick={() =>
								importToStore.mutate({ kind: k, name: item.name, sourcePath: item.path })
							}
						>
							Import to store
						</button>
					)}
					{item.state === 'orphaned' && (
						<button
							type="button"
							className="ngwa-btn warn"
							onClick={() => remove.mutate({ kind: k, name: item.name, scope: item.scopeKey })}
						>
							Remove dangling link
						</button>
					)}
					<button type="button" className="ngwa-btn" onClick={() => setPicker('move')}>
						Move to…
					</button>
					<button
						type="button"
						className="ngwa-btn"
						onClick={() => (crossEngineCopyable ? setShowCopyDrawer(true) : setPicker('copy'))}
						title={
							crossEngineCopyable
								? 'Copy to one or more engine + scope destinations (transcode where needed)'
								: undefined
						}
					>
						Copy to…
					</button>
					{item.state !== 'orphaned' && (
						<button
							type="button"
							className="ngwa-btn warn"
							onClick={() => remove.mutate({ kind: k, name: item.name, scope: item.scopeKey })}
						>
							{item.storeEntry ? 'Remove from scope' : 'Delete from store'}
						</button>
					)}
					<button type="button" className="ngwa-btn" onClick={() => onEdit(item.path)}>
						{item.mech === 'merge' ? 'Open settings' : 'Reveal'}
					</button>
				</div>
			</div>

			{picker && (
				<ScopePicker
					title={picker === 'move' ? 'Move to…' : 'Copy to…'}
					desc={`Destination scope for "${item.name}".`}
					scopes={projectScopes}
					disableScope={item.scopeKey}
					onPick={(toScope) => {
						if (picker === 'move')
							move.mutate({ kind: k, name: item.name, fromScope: item.scopeKey, toScope });
						else copy.mutate({ kind: k, name: item.name, fromScope: item.scopeKey, toScope });
						setPicker(null);
					}}
					onClose={() => setPicker(null)}
				/>
			)}

			{showCopyDrawer && (
				<WriteTranscodeDrawer
					item={item}
					present={present}
					projectScopes={projectScopes}
					onClose={() => setShowCopyDrawer(false)}
				/>
			)}
		</>
	);
}

function detailParts(item: NgwaItem): {
	fmRows: Array<[string, React.ReactNode]>;
	chips: React.ReactNode;
	body: string;
	tree: React.ReactNode;
} {
	const fmRows: Array<[string, React.ReactNode]> = [
		['system', ENGINE_META[item.system].display],
		['kind', item.storeKind],
		...(item.format
			? ([['format', FORMAT_LABEL[item.format]]] as Array<[string, React.ReactNode]>)
			: []),
		[
			'scope',
			<span>
				{item.scopeLabel}
				{item.projectRoot && (
					<span style={{ color: 'var(--fg-faint)' }}> · {shortPath(item.projectRoot)}</span>
				)}
			</span>,
		],
		[
			'source',
			item.storeEntry ? 'store ↗ (canonical)' : item.scope === 'personal' ? '~/.claude' : '.claude',
		],
	];

	let chips: React.ReactNode = null;
	let body = '';
	let tree: React.ReactNode = null;

	if (item.storeKind === 'agent') {
		const a = item.raw as ClaudeAgent;
		body = a.body;
		if (a.model) fmRows.push(['model', a.model]);
		const allowed = asStringArray(a.frontmatter['allowed-tools']);
		const skillsUsed = asStringArray(a.frontmatter['skills-used']);
		const { tools, mcp } = partitionTools(allowed);
		chips = (
			<>
				{skillsUsed.length > 0 && (
					<Section label="Skills used" count={`${skillsUsed.length}`}>
						<Chips values={skillsUsed} variant="skill" />
					</Section>
				)}
				{tools.length > 0 && (
					<Section label="Allowed tools" count={`${tools.length}`}>
						<Chips values={tools} variant="tool" initial={tools.length > 8 ? 8 : undefined} />
					</Section>
				)}
				{mcp.length > 0 && (
					<Section label="MCP tools" count={`${mcp.length}`}>
						<Chips values={mcp} variant="mcp" />
					</Section>
				)}
			</>
		);
	} else if (item.storeKind === 'skill') {
		const s = item.raw as ClaudeSkill;
		body = s.body;
		const allowed = asStringArray(s.frontmatter['allowed-tools']);
		chips =
			allowed.length > 0 ? (
				<Section label="Allowed tools" count={`${allowed.length}`}>
					<Chips values={allowed} variant="tool" />
				</Section>
			) : null;
		if (s.supportingFiles.length > 0) {
			tree = (
				<Section
					label="Supporting files"
					count={`${s.supportingFiles.length} files · ${formatBytes(
						s.supportingFiles.reduce((sum, f) => sum + f.size, 0)
					)}`}
				>
					<div className="ccfg-tree">
						<div className="ccfg-tree-row dir">{s.dirPath.split('/').filter(Boolean).pop()}/</div>
						<div className="ccfg-tree-row">
							<span className="indent" /> SKILL.md
						</div>
						{s.supportingFiles.map((f) => (
							<div className="ccfg-tree-row" key={f.path}>
								<span className="indent" /> {f.name}
								<span className="size">{formatBytes(f.size)}</span>
							</div>
						))}
					</div>
				</Section>
			);
		}
	} else if (item.storeKind === 'command') {
		const c = item.raw as ClaudeCommand;
		body = c.body;
		if (c.model) fmRows.push(['model', c.model]);
		if (c.argumentHint) fmRows.push(['argument-hint', c.argumentHint]);
		const allowed = asStringArray(c.frontmatter['allowed-tools']);
		const { tools, mcp } = partitionTools(allowed);
		chips = (
			<>
				{tools.length > 0 && (
					<Section label="Allowed tools" count={`${tools.length}`}>
						<Chips values={tools} variant="tool" initial={tools.length > 8 ? 8 : undefined} />
					</Section>
				)}
				{mcp.length > 0 && (
					<Section label="MCP tools" count={`${mcp.length}`}>
						<Chips values={mcp} variant="mcp" />
					</Section>
				)}
			</>
		);
	} else if (item.storeKind === 'hook') {
		const h = item.raw as ClaudeHook;
		fmRows.push(['event', h.event]);
		fmRows.push(['type', h.type]);
		chips = (
			<Section label="Event">
				<Chips values={[h.event]} variant="event" />
			</Section>
		);
	} else if (item.storeKind === 'mcp') {
		const m = item.raw as ClaudeMcp;
		fmRows.push(['transport', m.transport]);
		if (m.command) fmRows.push(['command', m.command]);
		if (m.url) fmRows.push(['url', m.url]);
		chips =
			m.envKeys.length > 0 ? (
				<Section label="Env vars" count={`${m.envKeys.length}`}>
					<Chips values={m.envKeys} variant="tool" />
				</Section>
			) : null;
	}

	return { fmRows, chips, body, tree };
}

// ─── STORE / catalog detail (G-09: installed-in + install-into-scope) ───────

function StoreDetail({
	entry,
	projectScopes,
	onEdit,
}: {
	entry: ClaudeStoreEntry;
	projectScopes: Array<{ key: ClaudeStoreScope; label: string }>;
	onEdit: (path: string) => void;
}) {
	const enable = useEnablePrimitive();
	const disable = useDisablePrimitive();
	const [installing, setInstalling] = useState(false);

	const enabledSet = new Set(entry.enabledIn);

	return (
		<>
			<div className="ccfg-detail-head">
				<div className="ccfg-detail-topline">
					<button
						type="button"
						className="ccfg-filepath"
						title={`Reveal ${entry.storePath}`}
						onClick={() => onEdit(entry.storePath)}
					>
						{shortPath(entry.storePath)}
					</button>
				</div>
				<h2>
					{entry.name}
					<span className="ccfg-scope-pill is-project">{KIND_ABBR[UI_KIND_OF[entry.kind]]}</span>
				</h2>
				<div style={{ marginTop: 6 }}>
					<span className="ngwa-dstate">Ọba · canonical store copy</span>
				</div>
				{entry.description && <div className="ccfg-detail-desc">{entry.description}</div>}
			</div>

			<div className="ccfg-detail-body">
				<Section label="Identity">
					<FrontmatterGrid
						entries={[
							['kind', entry.kind],
							[
								'store path',
								<span style={{ wordBreak: 'break-all' }}>{shortPath(entry.storePath)}</span>,
							],
						]}
					/>
				</Section>

				{/* G-09: installed-in scopes */}
				<Section label="Installed in" count={`${entry.enabledIn.length} scopes`}>
					<div className="ngwa-scopechips">
						{entry.enabledIn.length === 0 ? (
							<span className="ngwa-scopechip empty">Not installed in any scope</span>
						) : (
							entry.enabledIn.map((s) => (
								<span key={s} className="ngwa-scopechip">
									{s === 'workspace' ? 'workspace' : s.replace('project:', '')}
								</span>
							))
						)}
					</div>
				</Section>

				{/* G-09: install-into-scope picker */}
				<Section label="Install into scope">
					<div className="ngwa-acts">
						<button type="button" className="ngwa-btn primary" onClick={() => setInstalling(true)}>
							Install into scope…
						</button>
					</div>
				</Section>

				{/* per-scope enable/disable toggles */}
				<Section label="Per-scope state">
					<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
						{[
							{ key: 'workspace' as ClaudeStoreScope, label: 'Personal / workspace' },
							...projectScopes,
						].map((s) => {
							const isOn = enabledSet.has(s.key);
							return (
								<label key={s.key} className="ngwa-toggle">
									<span
										className={cn('ngwa-sw', isOn && 'on')}
										role="button"
										tabIndex={0}
										onClick={() =>
											isOn
												? disable.mutate({ kind: entry.kind, name: entry.name, scope: s.key })
												: enable.mutate({ kind: entry.kind, name: entry.name, scope: s.key })
										}
									/>
									<span className="ngwa-stword" style={{ textTransform: 'none' }}>
										{s.label}
									</span>
								</label>
							);
						})}
					</div>
				</Section>
			</div>

			{installing && (
				<ScopePicker
					title="Install into scope…"
					desc={`Symlink/merge "${entry.name}" into a scope.`}
					scopes={[{ key: 'workspace', label: 'Personal / workspace' }, ...projectScopes]}
					disabledScopes={entry.enabledIn}
					onPick={(scope) => {
						enable.mutate({ kind: entry.kind, name: entry.name, scope });
						setInstalling(false);
					}}
					onClose={() => setInstalling(false)}
				/>
			)}
		</>
	);
}

// ─── Scope picker modal ─────────────────────────────────────────────────────

function ScopePicker({
	title,
	desc,
	scopes,
	disableScope,
	disabledScopes,
	onPick,
	onClose,
}: {
	title: string;
	desc: string;
	scopes: Array<{ key: ClaudeStoreScope; label: string }>;
	disableScope?: ClaudeStoreScope;
	disabledScopes?: ClaudeStoreScope[];
	onPick: (scope: ClaudeStoreScope) => void;
	onClose: () => void;
}) {
	const dis = new Set(disabledScopes ?? []);
	return (
		<div className="ngwa-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
			<div className="ngwa-modal">
				<h3>{title}</h3>
				<p>{desc}</p>
				<div className="ngwa-pick">
					{scopes.map((s) => {
						const disabled = s.key === disableScope || dis.has(s.key);
						return (
							<button
								key={s.key}
								type="button"
								disabled={disabled}
								onClick={() => !disabled && onPick(s.key)}
							>
								{s.label}
								<span className="pp">
									{s.key === 'workspace' ? '~/.claude' : '.claude/'}
									{disabled ? ' · already there' : ''}
								</span>
							</button>
						);
					})}
				</div>
				<div className="foot">
					<button type="button" className="ngwa-btn" onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
