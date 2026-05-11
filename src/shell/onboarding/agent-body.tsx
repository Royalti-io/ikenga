// Step 2 — Coding agent picker.
//
// Calls `detectAgents()`, renders a card grid, and writes the user's
// choice to `onboarding.selectedAgentId`. Empty-state offers an
// "offline mode" CTA that pins `engine-noop` (the no-op engine pkg). If
// the selected agent's auth probe came back `false`, a banner surfaces
// the hint but Continue stays enabled — auth gaps can be fixed later
// from Settings.
//
// Mirrors prototypes `02-coding-agent.html` + `02-coding-agent-empty.html`.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { open as openExternal } from '@tauri-apps/plugin-shell';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { type DetectedAgent, detectAgents } from '@/lib/tauri-cmd';
import { useShellStore } from '@/lib/shell/shell-store';

import { useOnboardingStep } from './use-onboarding-step';

export interface AgentStepPayload {
	agentId: string;
	/** Snapshot of the selected agent for the summary screen. May be
	 *  null when the user picked the no-op offline engine. */
	display?: string;
	executablePath?: string;
	version?: string | null;
	authed?: boolean | null;
}

interface AgentBodyProps {
	onContinue: () => void;
}

const QUERY_KEY = ['onboarding', 'agents'] as const;

const OFFLINE_AGENT_ID = 'engine-noop';

// Install-hint links surfaced under "Don't see yours?" when a known agent
// is missing from the detected list. We keep these short — full setup
// docs live on the agent's own site.
const INSTALL_HINTS: Record<string, { display: string; url: string; cmd?: string }> = {
	'claude-code': {
		display: 'Claude Code',
		url: 'https://docs.anthropic.com/en/docs/claude-code',
		cmd: 'npm install -g @anthropic-ai/claude-code',
	},
	codex: {
		display: 'OpenAI Codex CLI',
		url: 'https://platform.openai.com/docs/guides/codex',
		cmd: 'npm install -g @openai/codex',
	},
	'gemini-cli': {
		display: 'Gemini CLI',
		url: 'https://github.com/google-gemini/gemini-cli',
		cmd: 'npm install -g @google/gemini-cli',
	},
	'cursor-agent': {
		display: 'Cursor Agent',
		url: 'https://docs.cursor.com/en/cli',
	},
	opencode: {
		display: 'OpenCode',
		url: 'https://opencode.ai',
	},
	aider: {
		display: 'Aider',
		url: 'https://aider.chat',
		cmd: 'pip install aider-chat',
	},
};

export function AgentBody({ onContinue }: AgentBodyProps) {
	const { record, setPayload } = useOnboardingStep<AgentStepPayload>('agent');
	const selectedAgentId = useShellStore((s) => s.onboarding.selectedAgentId);
	const setSelectedAgentId = useShellStore((s) => s.setSelectedAgentId);

	const { data, isLoading, isError, error, refetch } = useQuery<DetectedAgent[]>({
		queryKey: QUERY_KEY,
		queryFn: detectAgents,
		refetchOnWindowFocus: false,
	});

	const agents = data ?? [];
	const selected = agents.find((a) => a.id === selectedAgentId) ?? null;
	const isOffline = selectedAgentId === OFFLINE_AGENT_ID;
	const missingAuth = !!(selected && selected.authed === false);

	// Pre-select the first detected agent the first time the user lands
	// here. Honour any existing choice (e.g. user came back from a later
	// step via Settings).
	useEffect(() => {
		if (isLoading) return;
		if (selectedAgentId) return;
		const first = agents[0];
		if (first) {
			setSelectedAgentId(first.id);
			setPayload({
				agentId: first.id,
				display: first.display,
				executablePath: first.executable_path,
				version: first.version,
				authed: first.authed,
			});
		}
	}, [agents, isLoading, selectedAgentId, setPayload, setSelectedAgentId]);

	const handleSelect = (a: DetectedAgent) => {
		setSelectedAgentId(a.id);
		setPayload({
			agentId: a.id,
			display: a.display,
			executablePath: a.executable_path,
			version: a.version,
			authed: a.authed,
		});
	};

	const handleOffline = () => {
		setSelectedAgentId(OFFLINE_AGENT_ID);
		setPayload({
			agentId: OFFLINE_AGENT_ID,
			display: 'Offline (no engine)',
			authed: null,
		});
	};

	return (
		<div className="mx-auto max-w-5xl">
			<div className="mb-8 flex items-end justify-between gap-6">
				<div>
					<p
						className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
						style={{ color: 'var(--primary)' }}
					>
						Pick your engine
					</p>
					<h1 className="text-3xl font-bold leading-tight tracking-tight">
						Which coding agent should drive your workspace?
					</h1>
					<p className="mt-2 max-w-[60ch] text-sm" style={{ color: 'var(--fg-muted)' }}>
						{isLoading
							? 'Scanning your $PATH and the usual install locations…'
							: agents.length > 0
								? `We found ${agents.length} on your machine. You can switch later from Settings → Engine.`
								: "We couldn't find any agents. Install one below or continue offline."}
					</p>
				</div>
				{!isLoading && (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => refetch()}
						data-testid="agents-rescan"
					>
						Re-scan
					</Button>
				)}
			</div>

			{isError && (
				<div
					className="mb-6 rounded-md border p-4 text-sm"
					style={{
						borderColor: 'var(--danger)',
						color: 'var(--fg)',
						background: 'var(--danger-soft)',
					}}
					data-testid="agents-error"
				>
					Detection failed: {String((error as Error)?.message ?? error)}
				</div>
			)}

			{/* ── Detected agents grid ─────────────────────────────────────── */}
			{!isLoading && agents.length > 0 && (
				<div className="grid gap-4 md:grid-cols-2" data-testid="agents-grid">
					{agents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							selected={selectedAgentId === agent.id}
							onSelect={() => handleSelect(agent)}
						/>
					))}
				</div>
			)}

			{/* ── Empty state ──────────────────────────────────────────────── */}
			{!isLoading && agents.length === 0 && (
				<div
					className="rounded-md border p-6"
					style={{
						borderColor: 'var(--border-soft)',
						background: 'var(--bg-surface)',
					}}
					data-testid="agents-empty"
				>
					<h2 className="mb-2 text-base font-semibold">No coding agents detected</h2>
					<p className="mb-4 text-sm" style={{ color: 'var(--fg-muted)' }}>
						We scanned <span className="font-mono text-xs">$PATH</span> and the usual install dirs.
						Install one of these and re-scan, or continue without an engine.
					</p>
					<div className="grid gap-2">
						{Object.entries(INSTALL_HINTS).map(([id, hint]) => (
							<div
								key={id}
								className="flex items-center justify-between gap-3 rounded-md border px-4 py-2"
								style={{ borderColor: 'var(--border-soft)' }}
							>
								<div>
									<div className="text-[13px] font-semibold">{hint.display}</div>
									{hint.cmd && (
										<div className="mt-0.5 font-mono text-xs" style={{ color: 'var(--fg-faint)' }}>
											{hint.cmd}
										</div>
									)}
								</div>
								<button
									type="button"
									onClick={() => void openExternal(hint.url).catch(() => {})}
									className="text-xs underline-offset-2 hover:underline"
									style={{ color: 'var(--primary)' }}
								>
									Docs →
								</button>
							</div>
						))}
					</div>
					<div className="mt-6 flex items-center justify-between gap-4 rounded-md border border-dashed p-4">
						<div>
							<div className="text-sm font-semibold">Use Ikenga without an agent</div>
							<div className="mt-0.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
								Pkg management, files, terminal, project routing still work. AI features stay
								dormant.
							</div>
						</div>
						<Button variant="secondary" onClick={handleOffline} data-testid="agents-offline-cta">
							{isOffline ? 'Offline selected' : 'Use offline mode'}
						</Button>
					</div>
				</div>
			)}

			{/* ── Don't see yours? expander ────────────────────────────────── */}
			{!isLoading && agents.length > 0 && <DontSeeYours installedIds={agents.map((a) => a.id)} />}

			{/* ── Offline-mode strip when agents *were* found ─────────────── */}
			{!isLoading && agents.length > 0 && (
				<div
					className="mt-6 flex items-center gap-4 rounded-md border border-dashed p-4"
					style={{ borderColor: 'var(--border-strong)' }}
				>
					<div
						className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-bold"
						style={{
							background: 'var(--info, var(--bg-raised))',
							color: 'var(--info-fg, var(--fg))',
						}}
						aria-hidden="true"
					>
						i
					</div>
					<div className="flex-1">
						<div className="text-[13px] font-semibold">Or use Ikenga without an agent</div>
						<div className="mt-0.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
							AI features stay dormant until you connect one.
						</div>
					</div>
					<Button
						variant={isOffline ? 'default' : 'secondary'}
						size="sm"
						onClick={handleOffline}
						data-testid="agents-offline-alt"
					>
						{isOffline ? 'Offline selected' : 'Continue offline'}
					</Button>
				</div>
			)}

			{/* ── Auth-warning banner ──────────────────────────────────────── */}
			{missingAuth && (
				<div
					className="mt-6 rounded-md border p-4"
					style={{
						borderColor: 'var(--warning, var(--border-strong))',
						background: 'var(--warning-soft, var(--bg-surface))',
					}}
					data-testid="agents-auth-warning"
				>
					<div className="text-[13px] font-semibold">{selected?.display} isn't signed in yet</div>
					<div className="mt-1 text-xs" style={{ color: 'var(--fg-muted)' }}>
						{selected?.auth_hint ??
							'Run the agent CLI once to authenticate, or set the relevant API key in your environment. You can finish onboarding now and fix this later from Settings → Engine.'}
					</div>
				</div>
			)}

			{/* ── Inline Continue (footer also has one) ───────────────────── */}
			<div className="mt-8 flex items-center justify-end gap-3">
				<Button
					onClick={onContinue}
					disabled={!selectedAgentId}
					data-testid="agent-inline-continue"
				>
					{selectedAgentId ? 'Continue' : 'Pick an agent or use offline mode'}
				</Button>
			</div>

			{/* Persisted record marker — used by Settings re-entry to highlight
			    the current choice. Read-only display. */}
			{record.payload?.agentId && record.payload.agentId !== selectedAgentId && (
				<p
					className="mt-3 text-right text-xs"
					style={{ color: 'var(--fg-faint)' }}
					data-testid="agent-record-hint"
				>
					Previously selected: {record.payload.display ?? record.payload.agentId}
				</p>
			)}
		</div>
	);
}

interface AgentCardProps {
	agent: DetectedAgent;
	selected: boolean;
	onSelect: () => void;
}

function AgentCard({ agent, selected, onSelect }: AgentCardProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				'relative rounded-lg border p-5 text-left transition-colors',
				selected ? 'shadow-sm' : 'hover:border-[var(--border-strong)]'
			)}
			style={{
				borderColor: selected ? 'var(--primary)' : 'var(--border-soft)',
				background: 'var(--bg-surface)',
				boxShadow: selected ? '0 0 0 1px var(--primary)' : undefined,
			}}
			data-testid="agent-card"
			data-agent-id={agent.id}
			data-selected={selected}
		>
			{selected && (
				<span
					className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold"
					style={{ background: 'var(--primary)', color: 'var(--primary-fg, white)' }}
					aria-hidden="true"
				>
					✓
				</span>
			)}

			<div className="mb-4 flex items-center gap-3">
				<div
					className="flex h-9 w-9 flex-none items-center justify-center rounded-md font-mono text-sm font-bold"
					style={{ background: 'var(--bg-raised)', color: 'var(--fg-muted)' }}
					aria-hidden="true"
				>
					{agent.display.charAt(0)}
				</div>
				<div className="min-w-0">
					<div className="truncate text-[15px] font-bold leading-tight">{agent.display}</div>
					<div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
						id: <span className="font-mono">{agent.id}</span>
					</div>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5">
				<AuthPill authed={agent.authed} />
				{agent.version && (
					<Pill>
						<span className="font-mono text-[11px]">{agent.version}</span>
					</Pill>
				)}
				{agent.capabilities.tool_use && <Pill>tools</Pill>}
				{agent.capabilities.mcp && <Pill>mcp</Pill>}
				{agent.capabilities.session_resume && <Pill>resume</Pill>}
				{agent.capabilities.thinking && <Pill>thinking</Pill>}
			</div>

			<div
				className="mt-3 border-t border-dashed pt-3 text-xs"
				style={{ borderColor: 'var(--border-soft)' }}
			>
				<div className="flex gap-3">
					<span className="w-20 flex-none" style={{ color: 'var(--fg-faint)' }}>
						Binary
					</span>
					<span className="truncate font-mono text-[11.5px]" title={agent.executable_path}>
						{agent.executable_path}
					</span>
				</div>
			</div>
		</button>
	);
}

function Pill({ children }: { children: React.ReactNode }) {
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
			style={{ background: 'var(--bg-raised)', color: 'var(--fg-muted)' }}
		>
			{children}
		</span>
	);
}

function AuthPill({ authed }: { authed: boolean | null }) {
	if (authed === true) {
		return (
			<span
				className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
				style={{ background: 'var(--success-soft, var(--bg-raised))', color: 'var(--success)' }}
			>
				<span
					className="h-1.5 w-1.5 rounded-full"
					style={{ background: 'var(--success)' }}
					aria-hidden="true"
				/>
				signed in
			</span>
		);
	}
	if (authed === false) {
		return (
			<span
				className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
				style={{
					background: 'var(--warning-soft, var(--bg-raised))',
					color: 'var(--warning, var(--fg-muted))',
				}}
			>
				<span
					className="h-1.5 w-1.5 rounded-full"
					style={{ background: 'var(--warning, var(--fg-muted))' }}
					aria-hidden="true"
				/>
				auth required
			</span>
		);
	}
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
			style={{ background: 'var(--bg-raised)', color: 'var(--fg-faint)' }}
		>
			auth unknown
		</span>
	);
}

function DontSeeYours({ installedIds }: { installedIds: string[] }) {
	const installed = new Set(installedIds);
	const missing = Object.entries(INSTALL_HINTS).filter(([id]) => !installed.has(id));
	if (missing.length === 0) return null;
	return (
		<details className="mt-6">
			<summary
				className="cursor-pointer text-sm font-medium"
				style={{ color: 'var(--fg-muted)' }}
				data-testid="dont-see-yours"
			>
				Don't see yours?
			</summary>
			<div className="mt-3 grid gap-2">
				{missing.map(([id, hint]) => (
					<div
						key={id}
						className="flex items-center justify-between gap-3 rounded-md border px-4 py-2"
						style={{ borderColor: 'var(--border-soft)' }}
					>
						<div>
							<div className="text-[13px] font-semibold">{hint.display}</div>
							{hint.cmd && (
								<div className="mt-0.5 font-mono text-xs" style={{ color: 'var(--fg-faint)' }}>
									{hint.cmd}
								</div>
							)}
						</div>
						<button
							type="button"
							onClick={() => void openExternal(hint.url).catch(() => {})}
							className="text-xs underline-offset-2 hover:underline"
							style={{ color: 'var(--primary)' }}
						>
							Install docs →
						</button>
					</div>
				))}
			</div>
		</details>
	);
}

// ── Pure helpers (testable without DOM) ─────────────────────────────────

/** Decide whether the auth-warning banner should render for the given
 *  selected agent. */
export function shouldShowAuthWarning(agent: DetectedAgent | null | undefined): boolean {
	return !!agent && agent.authed === false;
}

/** Build the payload we persist when an agent card is selected. Kept as
 *  a named function so tests can lock down the shape without spinning up
 *  the component. */
export function agentToPayload(agent: DetectedAgent): AgentStepPayload {
	return {
		agentId: agent.id,
		display: agent.display,
		executablePath: agent.executable_path,
		version: agent.version,
		authed: agent.authed,
	};
}

/** The offline fallback payload — exported so the summary step and tests
 *  share the same constant. */
export const OFFLINE_PAYLOAD: AgentStepPayload = Object.freeze({
	agentId: OFFLINE_AGENT_ID,
	display: 'Offline (no engine)',
	authed: null,
});
