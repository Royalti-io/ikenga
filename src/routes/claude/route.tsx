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
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { Bot, FileText, Folder, Plug, RefreshCcw, Terminal as TermIcon, Zap } from 'lucide-react';

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
import type { ClaudeCommand } from '@/lib/tauri-cmd';

import '@/shell/claude-config/claude-config.css';

const TABS = [
	{ to: '/claude', label: 'Agents', exact: true, icon: Bot, key: 'agents' as const },
	{ to: '/claude/skills', label: 'Skills', icon: Zap, key: 'skills' as const },
	{ to: '/claude/commands', label: 'Commands', icon: TermIcon, key: 'commands' as const },
	{ to: '/claude/hooks', label: 'Hooks', icon: FileText, key: 'hooks' as const },
	{ to: '/claude/mcps', label: 'MCP', icon: Plug, key: 'mcps' as const },
];

export const Route = createFileRoute('/claude')({
	component: ClaudeLayout,
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
				<div className="min-h-0 flex-1">
					{browserMode === 'layered' ? (
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
			{(
				[
					{ id: 'layered' as const, label: 'Layered' },
					{ id: 'roots' as const, label: 'Project Roots' },
				]
			).map((opt) => (
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
}: {
	path: string;
	counts: { agents: number; skills: number; commands: number; hooks: number; mcps: number } | null;
}) {
	const navigate = useNavigate();
	return (
		<div className="ccfg-tabs">
			{TABS.map((t) => {
				const isOn = t.exact ? path === t.to : path.startsWith(t.to);
				const count = counts ? counts[t.key] : undefined;
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
