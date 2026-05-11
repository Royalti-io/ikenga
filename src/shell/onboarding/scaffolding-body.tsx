// Step 6 — .claude/ scaffolding (UI shell — Phase 6 wires the action).
//
// Behaviour matrix:
//
//   selectedAgentId !== 'claude-code'        → step auto-skips (informational
//                                              card + Continue jumps ahead).
//   primary root has no .claude/             → preview a starter pack;
//                                              "Scaffold now" calls the
//                                              Phase 6 Tauri cmd.
//   primary root already has .claude/        → show inventory + Replace /
//                                              Merge / Skip choice (Merge is
//                                              the recommended default per
//                                              the Phase 1 dialog mock).
//
// Phase 4 only ships the UI. The action button calls
// `scaffoldAgentConfig()` which currently returns
// `Err("not_implemented")` — the body catches that and renders a hint
// pointing at Phase 6.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useShellStore } from '@/lib/shell/shell-store';
import { type AgentConfigInventory, detectAgentConfig, scaffoldAgentConfig } from '@/lib/tauri-cmd';

import { useOnboardingStep } from './use-onboarding-step';

export type ScaffoldingChoice = 'scaffold' | 'merge' | 'skip' | 'na';

export interface ScaffoldingPayload {
	choice: ScaffoldingChoice;
	rootPath: string | null;
	profile: 'starter' | 'minimal' | 'none';
	/** ms since epoch when the action ran (or skip recorded). */
	at: number;
}

interface ScaffoldingBodyProps {
	onContinue: () => void;
	onSkip: () => void;
}

const STARTER_PREVIEW = {
	profile: 'starter' as const,
	skills: 14,
	agents: 5,
	commands: 9,
	title: 'Music label starter',
	description:
		'Outbound, A&R review, release planner, sales digest. Built around @royalti editorial standards.',
};

export function ScaffoldingBody({ onContinue, onSkip }: ScaffoldingBodyProps) {
	const selectedAgentId = useShellStore((s) => s.onboarding.selectedAgentId);
	const claudeProjectRoots = useShellStore((s) => s.claudeProjectRoots);
	const fileRoots = useShellStore((s) => s.fileRoots);
	const { setPayload, markCompleted, markSkipped } =
		useOnboardingStep<ScaffoldingPayload>('scaffolding');

	// Primary root := first project root if any, else first file root, else
	// null. The user can still navigate Back to re-pick if this looks wrong.
	const primaryRoot = claudeProjectRoots[0] ?? fileRoots[0] ?? null;

	const isClaudeAgent = selectedAgentId === 'claude-code';

	const { data: inventory, isLoading: inventoryLoading } = useQuery<AgentConfigInventory>({
		enabled: isClaudeAgent && !!primaryRoot,
		queryKey: ['onboarding', 'agent-config', 'claude-code', primaryRoot],
		queryFn: () => detectAgentConfig('claude-code', primaryRoot as string),
		refetchOnWindowFocus: false,
	});

	const [choice, setChoice] = useState<ScaffoldingChoice>(() => 'scaffold');
	const [busy, setBusy] = useState(false);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	// Default the choice depending on whether .claude/ already exists.
	useEffect(() => {
		if (!inventory) return;
		if (inventory.config_dir_present) {
			setChoice('merge');
		} else {
			setChoice('scaffold');
		}
	}, [inventory]);

	// Auto-skip path: non-claude agent. Record skip and let the wizard
	// chrome drive the user past this step.
	if (!isClaudeAgent) {
		return (
			<div className="mx-auto max-w-2xl">
				<p
					className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
					style={{ color: 'var(--primary)' }}
				>
					Scaffolding
				</p>
				<h1 className="text-3xl font-bold leading-tight tracking-tight">
					Skipping scaffolding for your engine.
				</h1>
				<p className="mt-3 text-sm" style={{ color: 'var(--fg-muted)' }}>
					Scaffolding currently only ships for Claude Code (the{' '}
					<span className="font-mono text-xs">.claude/</span> layout). When we add starter packs for
					other agents we'll surface them here automatically.
				</p>

				<div className="mt-6 flex items-center justify-end gap-3">
					<Button
						onClick={() => {
							setPayload({
								choice: 'na',
								rootPath: primaryRoot,
								profile: 'none',
								at: Date.now(),
							});
							markSkipped();
							onSkip();
						}}
						data-testid="scaffolding-auto-skip"
					>
						Continue
					</Button>
				</div>
			</div>
		);
	}

	if (!primaryRoot) {
		return (
			<div className="mx-auto max-w-2xl">
				<p
					className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
					style={{ color: 'var(--primary)' }}
				>
					Scaffolding
				</p>
				<h1 className="text-3xl font-bold leading-tight tracking-tight">
					No primary root selected.
				</h1>
				<p className="mt-3 text-sm" style={{ color: 'var(--fg-muted)' }}>
					Scaffolding needs at least one project root to write into. Go back to step 3 and add a
					root, or skip this step and run <span className="font-mono text-xs">ikenga scaffold</span>{' '}
					later.
				</p>
				<div className="mt-6 flex items-center justify-end gap-3">
					<Button
						variant="ghost"
						onClick={() => {
							setPayload({
								choice: 'skip',
								rootPath: null,
								profile: 'none',
								at: Date.now(),
							});
							markSkipped();
							onSkip();
						}}
					>
						Skip
					</Button>
				</div>
			</div>
		);
	}

	const hasExisting = inventory?.config_dir_present === true;

	const handleScaffoldNow = async () => {
		if (!primaryRoot) return;
		setBusy(true);
		setErrorMsg(null);
		try {
			const result = await scaffoldAgentConfig('claude-code', primaryRoot, STARTER_PREVIEW.profile);
			setPayload({
				choice: hasExisting ? 'merge' : 'scaffold',
				rootPath: primaryRoot,
				profile: STARTER_PREVIEW.profile,
				at: Date.now(),
			});
			markCompleted();
			onContinue();
			// Surface the result for debugging if Phase 6 returns useful data.
			void result;
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			setErrorMsg(msg);
			setBusy(false);
		}
	};

	const handleSkip = () => {
		setPayload({
			choice: 'skip',
			rootPath: primaryRoot,
			profile: 'none',
			at: Date.now(),
		});
		markSkipped();
		onSkip();
	};

	return (
		<div className="mx-auto max-w-4xl">
			<div className="mb-6">
				<p
					className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
					style={{ color: 'var(--primary)' }}
				>
					Scaffolding
				</p>
				<h1 className="text-3xl font-bold leading-tight tracking-tight">
					{hasExisting ? 'This root already has a .claude/ directory.' : 'Scaffold a starter set?'}
				</h1>
				<p className="mt-2 max-w-[60ch] text-sm" style={{ color: 'var(--fg-muted)' }}>
					Writes into <span className="font-mono text-xs">{primaryRoot}/.claude/</span>. Skip if
					you'd rather configure by hand — you can always run{' '}
					<span className="font-mono text-xs">ikenga scaffold</span> later.
				</p>
			</div>

			{inventoryLoading && (
				<div
					className="rounded-md border p-4 text-sm"
					style={{ borderColor: 'var(--border-soft)', color: 'var(--fg-muted)' }}
				>
					Inspecting <span className="font-mono">.claude/</span>…
				</div>
			)}

			{!inventoryLoading && hasExisting && inventory && (
				<div
					className="mb-6 rounded-md border p-5"
					style={{
						borderColor: 'var(--warning, var(--border-strong))',
						background: 'var(--warning-soft, var(--bg-surface))',
					}}
					data-testid="scaffolding-existing"
				>
					<div className="text-[13px] font-semibold">Existing inventory</div>
					<div className="mt-2 grid grid-cols-2 gap-y-1 text-xs sm:grid-cols-4">
						<InventoryCell label="agents" value={inventory.agent_count} />
						<InventoryCell label="skills" value={inventory.skill_count} />
						<InventoryCell label="commands" value={inventory.command_count} />
						<InventoryCell label="mcp servers" value={inventory.mcp_server_count} />
					</div>
				</div>
			)}

			{!inventoryLoading && (
				<div className="mb-6">
					<h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em]">
						{hasExisting ? 'What to do' : 'Preview · Music label starter'}
					</h2>
					{hasExisting ? (
						<div className="grid gap-2" data-testid="scaffolding-choice">
							<ChoiceRow
								selected={choice === 'merge'}
								onClick={() => setChoice('merge')}
								title="Merge into existing setup (recommended)"
								description={
									'Add new skills/agents/commands. Conflicts get a `.ikenga.new` suffix you can diff and merge by hand.'
								}
							/>
							<ChoiceRow
								selected={choice === 'skip'}
								onClick={() => setChoice('skip')}
								title="Skip — leave my config alone"
								description={
									'Continue without scaffolding. Run `ikenga scaffold` later if you change your mind.'
								}
							/>
							<ChoiceRow
								selected={choice === 'scaffold'}
								onClick={() => setChoice('scaffold')}
								title="Replace (back up first)"
								description={
									'Rename existing dir to `.claude.bak-YYYY-MM-DD` and scaffold fresh. Reversible.'
								}
							/>
						</div>
					) : (
						<div
							className="rounded-md border p-5"
							style={{ borderColor: 'var(--border-soft)' }}
							data-testid="scaffolding-preview"
						>
							<div className="text-[14px] font-semibold">{STARTER_PREVIEW.title}</div>
							<div className="mt-1 max-w-[60ch] text-xs" style={{ color: 'var(--fg-muted)' }}>
								{STARTER_PREVIEW.description}
							</div>
							<div className="mt-3 flex gap-4 text-xs" style={{ color: 'var(--fg-muted)' }}>
								<span>
									<strong className="font-semibold text-foreground">
										{STARTER_PREVIEW.skills}
									</strong>{' '}
									skills
								</span>
								<span>
									<strong className="font-semibold text-foreground">
										{STARTER_PREVIEW.agents}
									</strong>{' '}
									agents
								</span>
								<span>
									<strong className="font-semibold text-foreground">
										{STARTER_PREVIEW.commands}
									</strong>{' '}
									commands
								</span>
							</div>
						</div>
					)}
				</div>
			)}

			{errorMsg && (
				<div
					className="mb-4 rounded-md border p-4 text-sm"
					style={{
						borderColor: 'var(--warning, var(--border-strong))',
						background: 'var(--warning-soft, var(--bg-surface))',
					}}
					data-testid="scaffolding-error"
				>
					{errorMsg === 'not_implemented' ? (
						<>
							The scaffold action isn't wired yet — Phase 6 fills in this Tauri command. For now,
							pick "Skip" and run <span className="font-mono text-xs">ikenga scaffold</span> from
							the CLI after the wizard finishes.
						</>
					) : (
						<>Scaffold failed: {errorMsg}</>
					)}
				</div>
			)}

			<div className="mt-8 flex items-center justify-end gap-3">
				<Button variant="ghost" onClick={handleSkip} data-testid="scaffolding-skip">
					Skip
				</Button>
				<Button
					onClick={handleScaffoldNow}
					disabled={busy || choice === 'skip'}
					data-testid="scaffolding-action"
				>
					{busy ? 'Scaffolding…' : choice === 'merge' ? 'Merge & continue' : 'Scaffold & continue'}
				</Button>
			</div>
		</div>
	);
}

function InventoryCell({ label, value }: { label: string; value: number }) {
	return (
		<div>
			<span className="font-semibold text-foreground">{value}</span>{' '}
			<span style={{ color: 'var(--fg-muted)' }}>{label}</span>
		</div>
	);
}

interface ChoiceRowProps {
	selected: boolean;
	onClick: () => void;
	title: string;
	description: string;
}

function ChoiceRow({ selected, onClick, title, description }: ChoiceRowProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'flex items-start gap-3 rounded-md border p-4 text-left transition-colors',
				selected ? 'shadow-sm' : 'hover:border-[var(--border-strong)]'
			)}
			style={{
				borderColor: selected ? 'var(--primary)' : 'var(--border-soft)',
				background: 'var(--bg-surface)',
				boxShadow: selected ? '0 0 0 1px var(--primary)' : undefined,
			}}
			data-testid="scaffolding-choice-row"
			data-selected={selected}
		>
			<span
				className="mt-1 flex h-4 w-4 flex-none items-center justify-center rounded-full border"
				style={{
					borderColor: selected ? 'var(--primary)' : 'var(--border-strong)',
					background: selected ? 'var(--primary)' : 'transparent',
				}}
				aria-hidden="true"
			>
				{selected && (
					<span
						className="h-2 w-2 rounded-full"
						style={{ background: 'var(--primary-fg, white)' }}
					/>
				)}
			</span>
			<div>
				<div className="text-[13px] font-semibold">{title}</div>
				<div className="mt-1 text-xs" style={{ color: 'var(--fg-muted)' }}>
					{description}
				</div>
			</div>
		</button>
	);
}
