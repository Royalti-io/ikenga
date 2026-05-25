import {
	Outlet,
	createFileRoute,
	useLocation,
	useNavigate,
	useRouter,
} from '@tanstack/react-router';
// useNavigate is still used by the inner TabBar component (further down).
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, createContext, useContext } from 'react';
import { z } from 'zod';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import {
	Activity,
	Bot,
	FileText,
	Folder,
	Plug,
	RefreshCcw,
	Terminal as TermIcon,
	Zap,
} from 'lucide-react';

import {
	claudeConfigQueryOptions,
	useClaudeConfigWatch,
	type ClaudeConfig,
} from '@/lib/queries/claude-config';
import { useShellStore } from '@/lib/shell/shell-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';
import { cn } from '@/components/ui/utils';
import { LayeredView } from '@/shell/claude-config/layered-view';
import {
	NgwaSurface,
	type NgwaKindId,
	type NgwaScopeId,
	type NgwaSurfaceId,
} from '@/shell/claude-config/ngwa-surface';
import type { ClaudeCommand, ClaudeStoreScope } from '@/lib/tauri-cmd';

import '@/shell/claude-config/claude-config.css';

const TABS = [
	{ to: '/claude', label: 'Agents', exact: true, icon: Bot, key: 'agents' as const },
	{ to: '/claude/skills', label: 'Skills', icon: Zap, key: 'skills' as const },
	{ to: '/claude/commands', label: 'Commands', icon: TermIcon, key: 'commands' as const },
	{ to: '/claude/hooks', label: 'Hooks', icon: FileText, key: 'hooks' as const },
	{ to: '/claude/mcps', label: 'MCP', icon: Plug, key: 'mcps' as const },
	{ to: '/claude/runtime-mcps', label: 'Runtime', icon: Activity, key: 'runtime' as const },
];

// Ngwa deep-link params (threaded by WP-06's ngwa-mode.tsx sidebar). All
// optional — a bare `/claude` is the Ngwa Browse landing (surface=browse,
// scope=all, kind=skills).
const ngwaSearchSchema = z.object({
	surface: z.enum(['browse', 'registry', 'graph', 'map', 'life', 'health', 'flow']).optional(),
	// 'all' | 'personal' | `project:<id>` (one per scanned project root).
	scope: z.string().optional(),
	kind: z.enum(['skills', 'agents', 'commands', 'hooks', 'mcps', 'store']).optional(),
});

export const Route = createFileRoute('/claude')({
	component: ClaudeLayout,
	validateSearch: ngwaSearchSchema,
});

function ClaudeLayout() {
	const projectRoots = useShellStore((s) => s.claudeProjectRoots);
	const watchEnabled = useShellStore((s) => s.claudeWatchEnabled);
	const browserMode = useShellStore((s) => s.claudeBrowserMode);
	const setBrowserMode = useShellStore((s) => s.setClaudeBrowserMode);

	const query = useQuery(claudeConfigQueryOptions(projectRoots));
	useClaudeConfigWatch(projectRoots, watchEnabled);

	const router = useRouter();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [presetPrompt, setPresetPrompt] = useState<string>('');

	function handleOpenInEditor(path: string) {
		void shellOpen(path);
	}

	function handleOpenClaudeDir() {
		if (projectRoots[0]) {
			const root = projectRoots[0];
			void shellOpen(`${root}/.claude`);
		}
	}

	function handleNewAgentSession(agentName: string, _projectRoot: string | null) {
		setPresetPrompt(`Acting as the ${agentName} agent: `);
		setDialogOpen(true);
	}

	function handleRunCommand(cmd: ClaudeCommand) {
		if (!projectRoots[0]) return;
		const sessionId = createTerminalSession({
			cwd: projectRoots[0],
			cmd: buildClaudeWrappedCmd({ prompt: cmd.body }),
			title: `claude · ${cmd.name ?? cmd.body.slice(0, 32)}`,
		});
		const focusedId = usePaneStore.getState().focusedId;
		usePaneStore.getState().addTab(focusedId, { kind: 'terminal', sessionId });
	}

	const counts = useMemo(() => {
		if (!query.data) return null;
		return {
			agents: query.data.agents.length,
			skills: query.data.skills.length,
			commands: query.data.commands.length,
			hooks: query.data.hooks.length,
			mcps: query.data.mcps.length,
		};
	}, [query.data]);

	const ctx: ClaudeRouteContextValue = {
		config: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error ? String(query.error) : null,
		onEdit: handleOpenInEditor,
		onNewSession: handleNewAgentSession,
		onRunCommand: handleRunCommand,
	};

	const path = useLocation({ select: (l) => l.pathname });
	const isRuntimeRoute = path === '/claude/runtime-mcps';

	// Ngwa surface params (WP-07). The bare `/claude` path is the Ngwa Manage
	// surface (Browse/Registry + write actions). Child paths (`/claude/skills`
	// …) remain the legacy read-only browser chrome.
	const search = Route.useSearch();
	const isNgwaIndex = path === '/claude';
	const ngwaSurface: NgwaSurfaceId = search.surface ?? 'browse';
	const ngwaScope: NgwaScopeId = (search.scope as NgwaScopeId) ?? 'all';
	const ngwaKind: NgwaKindId = search.kind ?? 'skills';

	// Derive the move/copy/install destination scopes from the user's project
	// roots, mapping each root onto the store-scope grammar (`project:<id>`).
	const projectScopes = useMemo(
		() =>
			projectRoots.map((root) => {
				const id = root.split('/').filter(Boolean).pop() ?? 'project';
				return { key: `project:${id}` as ClaudeStoreScope, label: id };
			}),
		[projectRoots]
	);

	if (isNgwaIndex) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex-1 min-h-0">
					<NgwaSurface
						config={query.data ?? null}
						isLoading={query.isLoading}
						error={query.error ? String(query.error) : null}
						surface={ngwaSurface}
						scope={ngwaScope}
						kind={ngwaKind}
						onEdit={handleOpenInEditor}
						projectScopes={projectScopes}
					/>
				</div>
				<NewSessionDialog
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					defaultProjects={projectRoots}
					presetPrompt={presetPrompt}
				/>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col p-3">
			<div className="ccfg flex-1 min-h-0 flex flex-col">
				<Header
					counts={counts}
					onReload={() => router.invalidate({ filter: (m) => m.routeId.startsWith('/claude') })}
					onOpenDir={handleOpenClaudeDir}
				/>
				<ModeToggle mode={browserMode} onChange={setBrowserMode} />
				{browserMode === 'roots' && <Tabs path={path} counts={counts} />}
				{browserMode === 'layered' && <Tabs path={path} counts={counts} only={['runtime']} />}
				<div className="min-h-0 flex-1">
					{browserMode === 'layered' && !isRuntimeRoute ? (
						<LayeredView />
					) : (
						<Ctx.Provider value={ctx}>
							<Outlet />
						</Ctx.Provider>
					)}
				</div>
			</div>
			<NewSessionDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				defaultProjects={projectRoots}
				presetPrompt={presetPrompt}
			/>
		</div>
	);
}

function ModeToggle({
	mode,
	onChange,
}: {
	mode: 'layered' | 'roots';
	onChange: (m: 'layered' | 'roots') => void;
}) {
	return (
		<div className="flex items-center gap-1 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-1.5">
			<div
				className="mr-2 text-[10px] uppercase tracking-wide"
				style={{ color: 'var(--fg-faint)' }}
			>
				View
			</div>
			{[
				{ id: 'layered' as const, label: 'Layered' },
				{ id: 'roots' as const, label: 'Project Roots' },
			].map((opt) => (
				<button
					key={opt.id}
					type="button"
					onClick={() => onChange(opt.id)}
					className={cn(
						'rounded-[4px] border px-2 py-0.5 text-[11px]',
						mode === opt.id
							? 'border-[var(--border)] bg-[var(--bg-raised)] text-[var(--fg)]'
							: 'border-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-raised)]'
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

function Header({
	counts,
	onReload,
	onOpenDir,
}: {
	counts: { agents: number; skills: number; commands: number; hooks: number; mcps: number } | null;
	onReload: () => void;
	onOpenDir: () => void;
}) {
	return (
		<div className="flex items-center justify-between border-b border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-3">
			<div>
				<div
					className="flex items-center gap-2 text-[var(--fg)]"
					style={{
						fontFamily: 'var(--font-display)',
						fontSize: 'var(--text-h3)',
						fontWeight: 500,
					}}
				>
					<Bot size={18} style={{ color: 'var(--tint-fg-active, var(--primary))' }} />
					/claude
					{counts && (
						<span
							style={{
								fontFamily: 'var(--font-mono)',
								fontSize: 11,
								color: 'var(--fg-faint)',
								marginLeft: 8,
							}}
						>
							{counts.agents + counts.skills + counts.commands + counts.hooks + counts.mcps} entries
						</span>
					)}
				</div>
				<div style={{ fontSize: 'var(--text-caption)', color: 'var(--fg-muted)', marginTop: 2 }}>
					Project + personal config · live file watcher · read-only
				</div>
			</div>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onReload}
					className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--bg-raised)]"
				>
					<RefreshCcw size={11} /> Reload
				</button>
				<button
					type="button"
					onClick={onOpenDir}
					className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--bg-raised)]"
				>
					<Folder size={11} /> Open .claude/
				</button>
			</div>
		</div>
	);
}

function Tabs({
	path,
	counts,
	only,
}: {
	path: string;
	counts: { agents: number; skills: number; commands: number; hooks: number; mcps: number } | null;
	only?: ReadonlyArray<(typeof TABS)[number]['key']>;
}) {
	const navigate = useNavigate();
	const visible = only ? TABS.filter((t) => only.includes(t.key)) : TABS;
	return (
		<div className="ccfg-tabs">
			{visible.map((t) => {
				const isOn = t.exact ? path === t.to : path.startsWith(t.to);
				const count =
					counts && t.key !== 'runtime'
						? counts[t.key as Exclude<typeof t.key, 'runtime'>]
						: undefined;
				const Icon = t.icon;
				return (
					<button
						key={t.to}
						type="button"
						onClick={() => navigate({ to: t.to })}
						className={cn('ccfg-tab', isOn && 'is-on')}
					>
						<Icon />
						{t.label}
						{count != null && <span className="ccfg-tab-count">{count}</span>}
					</button>
				);
			})}
		</div>
	);
}

// ─── Context for child routes ──────────────────────────────────────────────

interface ClaudeRouteContextValue {
	config: ClaudeConfig | null;
	isLoading: boolean;
	error: string | null;
	onEdit: (path: string) => void;
	onNewSession: (agentName: string, projectRoot: string | null) => void;
	onRunCommand: (cmd: ClaudeCommand) => void;
}

const Ctx = createContext<ClaudeRouteContextValue | null>(null);

export function useClaudeRoute(): ClaudeRouteContextValue {
	const v = useContext(Ctx);
	if (!v) throw new Error('useClaudeRoute used outside /claude route');
	return v;
}
