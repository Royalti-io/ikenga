// Ngwa-mode sidebar. Activated by the activity-bar Ngwa icon (⌘6). Ngwa is
// the Claude-config management mode — it graduates the old App-mode /claude
// browser into its own activity-bar surface (store labelled Ọba).
//
// The sidebar is the *nav* (per D-05): a MANAGE + ANALYZE surface list, a
// SCOPE selector, and a KIND filter. KIND is a Manage-only control — it dims
// and disables on ANALYZE surfaces (analyze is Phase 4; KIND has no meaning
// there).
//
// This package (WP-06) owns the shell + sidebar shell only. The Browse 2-pane
// list/detail and the Registry / Analyze surface bodies are filled by WP-07,
// which renders into the `/claude` route the surface items deep-link into.
// Surface / scope / kind selections are threaded through the route as query
// params (`?surface=&scope=&kind=`) so the content side can read them — the
// same deep-link pattern PkgsMode uses for its `?filter=` pills.

import {
	Boxes,
	Cog,
	GitBranch,
	Layers,
	List,
	Network,
	Plug,
	Share2,
	Sparkles,
	SquareTerminal,
	Workflow,
	Zap,
	type LucideIcon,
} from 'lucide-react';

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useQuery } from '@tanstack/react-query';

import { cn } from '@/components/ui/utils';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useShellStore } from '@/lib/shell/shell-store';
import { claudeConfigQueryOptions, claudeStoreQueryOptions } from '@/lib/queries/claude-config';
import {
	buildItems,
	ENGINE_META,
	ENGINE_ORDER,
	resolveActiveSystems,
	summarizeSystems,
	type NgwaSystemId,
} from '@/shell/claude-config/ngwa-surface';

// Pulls in the WP-20 engine/format tint vars + `.ngwa-sysrow` rules so the
// SYSTEM facet styles even when the /claude route isn't mounted yet.
import '@/shell/claude-config/claude-config.css';

// ─── Surfaces (the route the content side renders) ────────────────────────
// MANAGE surfaces support the KIND filter; ANALYZE surfaces do not (KIND
// dims). The `group` drives both the section heading and the KIND-dim rule.
type SurfaceGroup = 'manage' | 'analyze';
type SurfaceId = 'browse' | 'registry' | 'graph' | 'map' | 'life' | 'health' | 'flow';

interface SurfaceItem {
	id: SurfaceId;
	label: string;
	Icon: LucideIcon;
	group: SurfaceGroup;
}

const SURFACES: SurfaceItem[] = [
	// MANAGE
	{ id: 'browse', label: 'Browse', Icon: Boxes, group: 'manage' },
	{ id: 'registry', label: 'Registry', Icon: List, group: 'manage' },
	// ANALYZE (Phase 4 — bodies land with WP-07/later)
	{ id: 'graph', label: 'Capability graph', Icon: Share2, group: 'analyze' },
	{ id: 'map', label: 'Store map', Icon: Network, group: 'analyze' },
	{ id: 'life', label: 'Hook lifecycle', Icon: GitBranch, group: 'analyze' },
	{ id: 'health', label: 'Inventory & health', Icon: Boxes, group: 'analyze' },
	{ id: 'flow', label: 'Orchestration flow', Icon: Workflow, group: 'analyze' },
];

const ANALYZE_SURFACES: ReadonlySet<SurfaceId> = new Set<SurfaceId>(
	SURFACES.filter((s) => s.group === 'analyze').map((s) => s.id)
);

const DEFAULT_SURFACE: SurfaceId = 'browse';

// ─── Scope (which config layer is in view) ────────────────────────────────
// `all` is the default (matches a bare URL). `personal` is the cross-cutting
// user layer; each scanned project root gets its own `project:<id>` row so you
// can narrow to one project. The id is the project-root basename, matching the
// scope key the content side derives in `scopeKeyOf`.
type ScopeId = 'all' | 'personal' | `project:${string}`;

interface ScopeItem {
	id: ScopeId;
	label: string;
	Icon: LucideIcon;
}

// Cross-cutting scopes always present; project rows are appended per render.
const SCOPE_BASE: ScopeItem[] = [
	{ id: 'all', label: 'All scopes', Icon: Layers },
	{ id: 'personal', label: 'Personal', Icon: Sparkles },
];

const DEFAULT_SCOPE: ScopeId = 'all';

// ─── Kind (Manage-only filter over config primitives) ─────────────────────
type KindId = 'skills' | 'agents' | 'commands' | 'hooks' | 'mcps' | 'store';

interface KindItem {
	id: KindId;
	label: string;
	Icon: LucideIcon;
}

const KINDS: KindItem[] = [
	{ id: 'skills', label: 'Skills', Icon: Zap },
	{ id: 'agents', label: 'Agents', Icon: Boxes },
	{ id: 'commands', label: 'Commands', Icon: SquareTerminal },
	{ id: 'hooks', label: 'Hooks', Icon: GitBranch },
	{ id: 'mcps', label: 'MCP', Icon: Plug },
	{ id: 'store', label: 'Ọba (store)', Icon: Network },
];

const DEFAULT_KIND: KindId = 'skills';

// Parse the comma-separated `sys` URL param into engine ids, dropping unknowns.
function parseSysParam(raw: string | null): NgwaSystemId[] {
	if (!raw) return [];
	const known = new Set<string>(ENGINE_ORDER);
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is NgwaSystemId => known.has(s));
}

const NGWA_ROUTE = '/claude';
// Runtime MCP status + supervisor lifecycle — a unique surface not covered by
// the Ngwa Browse/Registry/Analyze surfaces, re-surfaced here as its own item.
const RUNTIME_MCPS_ROUTE = '/claude/runtime-mcps';

export function NgwaMode() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);
	// One scope row per scanned project root (the source the content side keys
	// items to), appended after the cross-cutting all/personal scopes.
	const projectRoots = useShellStore((s) => s.claudeProjectRoots);
	const scopes: ScopeItem[] = [
		...SCOPE_BASE,
		...projectRoots.map((root) => {
			const id = root.split('/').filter(Boolean).pop() ?? 'project';
			return { id: `project:${id}` as ScopeId, label: id, Icon: Cog };
		}),
	];

	// Read the active surface / scope / kind off the focused pane's URL so the
	// highlight stays in sync with whatever the content side is rendering —
	// the same selector shape PkgsMode uses. `useShallow` is required:
	// returning a fresh object each call trips Zustand v5 + React 19's
	// useSyncExternalStore stability check otherwise.
	const active = usePaneStore(
		useShallow((s) => {
			const leaf = findLeaf(s.root, s.focusedId);
			if (!leaf)
				return { onRoute: false, path: null, surface: null, scope: null, kind: null, sys: null };
			const tab = leaf.tabs[leaf.activeTabIdx];
			if (!tab || tab.kind !== 'route') {
				return { onRoute: false, path: null, surface: null, scope: null, kind: null, sys: null };
			}
			const [path, qs] = tab.path.split('?');
			if (path !== NGWA_ROUTE && path !== RUNTIME_MCPS_ROUTE) {
				return { onRoute: false, path: null, surface: null, scope: null, kind: null, sys: null };
			}
			const q = new URLSearchParams(qs ?? '');
			return {
				onRoute: true,
				path,
				surface: q.get('surface'),
				scope: q.get('scope'),
				kind: q.get('kind'),
				sys: q.get('sys'),
			};
		})
	);

	// Surface / scope / kind selections only apply on the Ngwa index route; the
	// runtime-mcps child route is its own thing and must not light up Browse.
	const onNgwaIndex = active.onRoute && active.path === NGWA_ROUTE;
	const onRuntimeMcps = active.onRoute && active.path === RUNTIME_MCPS_ROUTE;
	const activeSurface: SurfaceId = (active.surface as SurfaceId) ?? DEFAULT_SURFACE;
	const activeScope: ScopeId = (active.scope as ScopeId) ?? DEFAULT_SCOPE;
	const activeKind: KindId = (active.kind as KindId) ?? DEFAULT_KIND;

	// KIND is a Manage-only control. On ANALYZE surfaces it dims + disables.
	const kindDisabled = ANALYZE_SURFACES.has(activeSurface);

	// ── SYSTEM facet (WP-20 / D-08) — engine multi-select ──
	// Build the same item model the surface does, off the same queries, so the
	// engine presence, per-engine counts, and aggregated Kind counts stay in
	// lockstep with the Browse list. The query is shared (TanStack dedups it).
	const projects = useShellStore((s) => s.projects);
	const configQuery = useQuery(claudeConfigQueryOptions(projectRoots));
	const storeQuery = useQuery(claudeStoreQueryOptions(null));
	const summary = useMemo(() => {
		const config = configQuery.data;
		if (!config) return null;
		return summarizeSystems(buildItems(config, storeQuery.data ?? [], projects));
	}, [configQuery.data, storeQuery.data, projects]);

	const present: NgwaSystemId[] = summary?.present ?? [];
	const selectedSystems = useMemo(() => parseSysParam(active.sys), [active.sys]);
	const activeSystemsSet = useMemo(
		() => resolveActiveSystems(selectedSystems, present),
		[selectedSystems, present]
	);
	// Aggregated Kind counts across the *active* systems (D-08 point 4).
	const kindCounts = useMemo(
		() => (summary ? summary.kindCounts(activeSystemsSet) : null),
		[summary, activeSystemsSet]
	);

	// Serialize a system selection back to the `sys` URL param. "All present"
	// drops the param entirely (the default), so the Claude-only / all-on view
	// carries no `sys` and stays identical to today.
	function sysParamFor(set: ReadonlySet<NgwaSystemId>): string | null {
		const picked = present.filter((e) => set.has(e));
		if (picked.length === 0 || picked.length === present.length) return null;
		return picked.join(',');
	}

	// Build the deep-link, preserving the orthogonal selections. Scope rides
	// along on every surface; kind only when the target surface is a MANAGE
	// surface (it's dropped from analyze links so a stale kind doesn't linger).
	function buildHref(next: {
		surface?: SurfaceId;
		scope?: ScopeId;
		kind?: KindId;
		sys?: string | null;
	}): string {
		const surface = next.surface ?? activeSurface;
		const scope = next.scope ?? activeScope;
		const kind = next.kind ?? activeKind;
		const sys = next.sys !== undefined ? next.sys : (active.sys ?? null);
		const params = new URLSearchParams();
		if (surface !== DEFAULT_SURFACE) params.set('surface', surface);
		if (scope !== DEFAULT_SCOPE) params.set('scope', scope);
		if (!ANALYZE_SURFACES.has(surface) && kind !== DEFAULT_KIND) {
			params.set('kind', kind);
		}
		// SYSTEM facet only meaningful on MANAGE surfaces (Browse/Registry).
		if (!ANALYZE_SURFACES.has(surface) && sys) params.set('sys', sys);
		const qs = params.toString();
		return qs ? `${NGWA_ROUTE}?${qs}` : NGWA_ROUTE;
	}

	// Toggle one engine in/out of the active set, then navigate with the new
	// `sys` param. Refuses to empty the set (toggling off the last active engine
	// is a no-op — there's always ≥1 system in view, matching the surface).
	function toggleSystem(engine: NgwaSystemId) {
		const nextSet = new Set(activeSystemsSet);
		if (nextSet.has(engine)) {
			if (nextSet.size <= 1) return; // keep ≥1 on
			nextSet.delete(engine);
		} else {
			nextSet.add(engine);
		}
		navigateFocused(buildHref({ sys: sysParamFor(nextSet) }));
	}

	function setAllSystems(on: boolean) {
		// "All" ⇒ drop the param (all present on). "None" is disallowed (≥1
		// always on); the None affordance resets to the first present engine.
		const next = on ? null : sysParamFor(new Set(present.slice(0, 1)));
		navigateFocused(buildHref({ sys: next }));
	}

	const manageSurfaces = SURFACES.filter((s) => s.group === 'manage');
	const analyzeSurfaces = SURFACES.filter((s) => s.group === 'analyze');

	function SurfaceList({ items }: { items: SurfaceItem[] }) {
		return (
			<ul className="flex flex-col">
				{items.map(({ id, label, Icon }) => {
					const isActive = onNgwaIndex && activeSurface === id;
					return (
						<li key={id}>
							<button
								type="button"
								data-surface={id}
								onClick={() => navigateFocused(buildHref({ surface: id }))}
								className={cn(
									'relative flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
									'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
									isActive && 'bg-accent font-medium'
								)}
								style={isActive ? { color: 'var(--tint-ngwa-fg)' } : undefined}
							>
								{isActive && (
									<span
										aria-hidden="true"
										className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
										style={{ background: 'var(--tint-ngwa-fg)' }}
									/>
								)}
								<Icon className="h-4 w-4 shrink-0" />
								<span className="truncate">{label}</span>
							</button>
						</li>
					);
				})}
			</ul>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-y-auto py-2">
			{/* ── MANAGE surfaces ── */}
			<div className="mb-2">
				<div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Manage
				</div>
				<SurfaceList items={manageSurfaces} />
			</div>

			{/* ── ANALYZE surfaces ── */}
			<div className="mb-2">
				<div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Analyze
				</div>
				<SurfaceList items={analyzeSurfaces} />
			</div>

			<div className="mx-4 my-2 border-t border-border-soft" />

			{/* ── SCOPE selector ── */}
			<div className="mb-2">
				<div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Scope
				</div>
				<ul className="flex flex-col">
					{scopes.map(({ id, label, Icon }) => {
						const isActive = onNgwaIndex && activeScope === id;
						return (
							<li key={id}>
								<button
									type="button"
									data-scope={id}
									onClick={() => navigateFocused(buildHref({ scope: id }))}
									className={cn(
										'relative flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
										'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
										isActive && 'bg-accent font-medium'
									)}
									style={isActive ? { color: 'var(--tint-ngwa-fg)' } : undefined}
								>
									{isActive && (
										<span
											aria-hidden="true"
											className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
											style={{ background: 'var(--tint-ngwa-fg)' }}
										/>
									)}
									<Icon className="h-4 w-4 shrink-0" />
									<span className="truncate">{label}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="mx-4 my-2 border-t border-border-soft" />

			{/* ── SYSTEM facet (WP-20 / D-08) — engine multi-select, Manage-only ── */}
			{present.length > 0 && (
				<>
					<div
						className={cn('mb-2', kindDisabled && 'pointer-events-none opacity-40')}
						aria-disabled={kindDisabled}
					>
						<div className="flex items-center justify-between px-4 pb-1 pt-1">
							<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
								System
							</span>
							{present.length > 1 && !kindDisabled && (
								<span className="font-mono text-[9px] lowercase tracking-wide text-muted-foreground/50">
									<button
										type="button"
										data-sys-all
										className="hover:text-foreground"
										onClick={() => setAllSystems(true)}
									>
										all
									</button>
									<span className="px-1">·</span>
									<button
										type="button"
										data-sys-none
										className="hover:text-foreground"
										onClick={() => setAllSystems(false)}
									>
										none
									</button>
								</span>
							)}
						</div>
						<ul className="flex flex-col">
							{present.map((engine) => {
								const meta = ENGINE_META[engine];
								const isOn = onNgwaIndex && !kindDisabled && activeSystemsSet.has(engine);
								const count = summary?.engineCounts[engine] ?? 0;
								return (
									<li key={engine}>
										<button
											type="button"
											data-system={engine}
											aria-pressed={isOn}
											disabled={kindDisabled}
											onClick={() => toggleSystem(engine)}
											className={cn(
												'ngwa-sysrow relative flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors',
												'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
												isOn && 'bg-accent',
												!isOn && 'opacity-50',
												kindDisabled && 'cursor-default'
											)}
										>
											<span className={cn('ngwa-eg', meta.code)} aria-hidden>
												{meta.badge}
											</span>
											<span className="truncate">{meta.display}</span>
											<span className="ngwa-sys-ct ml-auto font-mono text-[9px] text-muted-foreground/60">
												{count}
											</span>
											<span className={cn('ngwa-sys-chk', isOn && 'on')} aria-hidden>
												{isOn ? '✓' : ''}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>
					<div className="mx-4 my-2 border-t border-border-soft" />
				</>
			)}

			{/* ── KIND filter — Manage-only; dims + disables on Analyze surfaces ── */}
			<div
				className={cn('mb-2', kindDisabled && 'pointer-events-none opacity-40')}
				aria-disabled={kindDisabled}
			>
				<div className="flex items-center justify-between px-4 pb-1 pt-1">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
						Kind
					</span>
					{kindDisabled && (
						<span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">
							manage only
						</span>
					)}
				</div>
				<ul className="flex flex-col">
					{KINDS.map(({ id, label, Icon }) => {
						const isActive = onNgwaIndex && !kindDisabled && activeKind === id;
						// Aggregated count across active systems (D-08 point 4). `store`
						// is a catalog view, not a per-engine scan kind, so no count.
						const count = id === 'store' ? null : (kindCounts?.[id] ?? null);
						return (
							<li key={id}>
								<button
									type="button"
									data-kind={id}
									disabled={kindDisabled}
									onClick={() => navigateFocused(buildHref({ kind: id }))}
									className={cn(
										'relative flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
										'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
										isActive && 'bg-accent font-medium',
										kindDisabled && 'cursor-default'
									)}
									style={isActive ? { color: 'var(--tint-ngwa-fg)' } : undefined}
								>
									{isActive && (
										<span
											aria-hidden="true"
											className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
											style={{ background: 'var(--tint-ngwa-fg)' }}
										/>
									)}
									<Icon className="h-4 w-4 shrink-0" />
									<span className="truncate">{label}</span>
									{count != null && (
										<span className="ngwa-kind-ct ml-auto font-mono text-[9px] text-muted-foreground/60">
											{count}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="mx-4 my-2 border-t border-border-soft" />

			{/* ── Runtime MCPs — unique surface (status + supervisor lifecycle) ── */}
			<div className="mb-2">
				<ul className="flex flex-col">
					<li>
						<button
							type="button"
							data-runtime-mcps
							onClick={() => navigateFocused(RUNTIME_MCPS_ROUTE)}
							className={cn(
								'relative flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
								'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
								onRuntimeMcps && 'bg-accent font-medium'
							)}
							style={onRuntimeMcps ? { color: 'var(--tint-ngwa-fg)' } : undefined}
						>
							{onRuntimeMcps && (
								<span
									aria-hidden="true"
									className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
									style={{ background: 'var(--tint-ngwa-fg)' }}
								/>
							)}
							<Plug className="h-4 w-4 shrink-0" />
							<span className="truncate">Runtime MCPs</span>
						</button>
					</li>
				</ul>
			</div>
		</div>
	);
}
