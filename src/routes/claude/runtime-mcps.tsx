// Phase 5 deferred sub-UI — runtime MCP view.
//
// Driven by `/iyke/mcp/list`: shows the resolved 4-tier MCP set joined with
// supervisor lifecycle state. Restart targets `pkg_id` (long-lived only).
// Pin/Unpin reuses the Phase 4 asset-pin commands with `asset_kind = 'mcp'`.

import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Pin, PinOff, Plug, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/components/ui/utils';
import { iykeMcpListQueryOptions } from '@/lib/queries/iyke-mcp';
import { claudeAssetPinsQueryOptions, type ClaudeAssetPin } from '@/lib/queries/claude';
import { restartIykeMcp, type IykeMcpEntry, type IykeMcpTier } from '@/lib/iyke/mcp';
import { useShellStore } from '@/lib/shell/shell-store';
import {
	claudeAssetPin,
	claudeAssetUnpin,
	type ClaudeAssetTier,
	type Project,
} from '@/lib/tauri-cmd';

export const Route = createFileRoute('/claude/runtime-mcps')({
	component: RuntimeMcpsTab,
});

const TIER_LABEL: Record<IykeMcpTier, string> = {
	personal: 'Personal',
	workspace_pkg: 'Workspace pkg',
	project: 'Project',
	project_pkg: 'Project pkg',
};

const TIER_RANK: Record<IykeMcpTier, number> = {
	personal: 3,
	workspace_pkg: 2,
	project: 1,
	project_pkg: 0,
};

function RuntimeMcpsTab() {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const [selectedProjectId, setSelectedProjectId] = useState<string>(activeProjectId);

	const scope = `project:${selectedProjectId}`;
	const mcpQuery = useQuery(iykeMcpListQueryOptions(selectedProjectId));
	const pinsQuery = useQuery(claudeAssetPinsQueryOptions(scope));

	const pinByName = useMemo(() => {
		const m = new Map<string, ClaudeAssetPin>();
		for (const p of pinsQuery.data ?? []) {
			if (p.asset_kind === 'mcp') m.set(p.asset_name, p);
		}
		return m;
	}, [pinsQuery.data]);

	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Group rows by name, sub-sort by tier-rank (matches LayeredView).
	const grouped = useMemo(() => {
		const byName = new Map<string, IykeMcpEntry[]>();
		for (const e of mcpQuery.data?.mcps ?? []) {
			const xs = byName.get(e.name) ?? [];
			xs.push(e);
			byName.set(e.name, xs);
		}
		const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
		return names.map((name) => ({
			name,
			entries: byName
				.get(name)!
				.slice()
				.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]),
		}));
	}, [mcpQuery.data]);

	const totalEntries = mcpQuery.data?.mcps.length ?? 0;
	const nameCount = grouped.length;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2">
				<Popover>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
						>
							<FolderKanban className="h-3 w-3" />
							{selectedProject?.color && (
								<span
									aria-hidden
									style={{
										display: 'inline-block',
										width: 8,
										height: 8,
										borderRadius: 999,
										background: selectedProject.color,
									}}
								/>
							)}
							<span>{selectedProject?.display_name ?? selectedProjectId}</span>
						</button>
					</PopoverTrigger>
					<PopoverContent align="start" className="w-64 p-1">
						{projects
							.filter((p) => !p.archived_at)
							.map((p) => (
								<ProjectPickerRow
									key={p.id}
									project={p}
									active={p.id === selectedProjectId}
									onSelect={() => setSelectedProjectId(p.id)}
								/>
							))}
					</PopoverContent>
				</Popover>
				<div className="ml-auto flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
					{mcpQuery.isLoading && <span>Loading…</span>}
					{!mcpQuery.isLoading && (
						<span>
							{nameCount} server{nameCount === 1 ? '' : 's'} · {totalEntries} source
							{totalEntries === 1 ? '' : 's'}
						</span>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto px-4 py-3">
				{mcpQuery.error && (
					<div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
						Failed to load MCPs: {String(mcpQuery.error)}
					</div>
				)}
				{mcpQuery.data && grouped.length === 0 && (
					<div className="rounded-md border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
						No MCP servers visible from this project.
					</div>
				)}
				{grouped.length > 0 && (
					<div className="rounded-md border border-border bg-card">
						<div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
							<Plug className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="font-medium">MCP servers</span>
							<span className="font-mono text-[10px] text-muted-foreground">{nameCount}</span>
						</div>
						<div className="divide-y divide-border">
							{grouped.map(({ name, entries }) => (
								<ServerGroup
									key={name}
									name={name}
									entries={entries}
									scope={scope}
									pin={pinByName.get(name)}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function ProjectPickerRow({
	project,
	active,
	onSelect,
}: {
	project: Project;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent',
				active && 'bg-accent/50'
			)}
		>
			{project.color && (
				<span
					aria-hidden
					style={{
						display: 'inline-block',
						width: 8,
						height: 8,
						borderRadius: 999,
						background: project.color,
					}}
				/>
			)}
			<span>{project.display_name}</span>
			{active && (
				<span aria-hidden className="ml-auto">
					✓
				</span>
			)}
		</button>
	);
}

function ServerGroup({
	name,
	entries,
	scope,
	pin,
}: {
	name: string;
	entries: IykeMcpEntry[];
	scope: string;
	pin: ClaudeAssetPin | undefined;
}) {
	const queryClient = useQueryClient();

	const winner = useMemo(() => {
		if (pin) {
			const match = entries.find(
				(e) =>
					e.tier === pin.preferred_tier &&
					(pin.preferred_source ? e.provider === pin.preferred_source : true)
			);
			if (match) return match;
		}
		return entries[0]!;
	}, [pin, entries]);

	const pinMutation = useMutation({
		mutationFn: async (args: { tier: ClaudeAssetTier; provider: string | null }) => {
			await claudeAssetPin(scope, 'mcp', name, args.tier, args.provider);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['project-scoped', 'claude-asset-pins', { scope }],
			});
		},
	});

	const unpinMutation = useMutation({
		mutationFn: async () => {
			await claudeAssetUnpin(scope, 'mcp', name);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['project-scoped', 'claude-asset-pins', { scope }],
			});
		},
	});

	const [pinOpen, setPinOpen] = useState(false);

	return (
		<div className="flex flex-col gap-1.5 px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="truncate font-mono text-xs">{name}</span>
				<TierChip tier={winner.tier} provider={winner.provider} path={winner.path} />
				{entries.length > 1 && (
					<Badge
						variant="outline"
						className="border-amber-400/60 text-[10px] text-amber-600"
						title={entries
							.filter((e) => e !== winner)
							.map((e) => `${TIER_LABEL[e.tier]} · ${e.provider}`)
							.join('\n')}
					>
						Also in:{' '}
						{entries
							.filter((e) => e !== winner)
							.map((e) => TIER_LABEL[e.tier])
							.join(', ')}
					</Badge>
				)}
				<div className="ml-auto flex items-center gap-1">
					{pin && (
						<span className="font-mono text-[10px] text-muted-foreground">
							Pinned to {TIER_LABEL[pin.preferred_tier as IykeMcpTier]}
							{pin.preferred_source ? ` · ${pin.preferred_source}` : ''}
						</span>
					)}
					{pin ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-[11px]"
							onClick={() => unpinMutation.mutate()}
							disabled={unpinMutation.isPending}
						>
							<PinOff className="mr-1 h-3 w-3" /> Unpin
						</Button>
					) : (
						<Popover open={pinOpen} onOpenChange={setPinOpen}>
							<PopoverTrigger asChild>
								<Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]">
									<Pin className="mr-1 h-3 w-3" /> Pin
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-72 p-2">
								<div className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
									Pin {name} to:
								</div>
								<div className="space-y-0.5">
									{entries.map((e) => (
										<button
											key={`${e.tier}:${e.provider}:${e.path}`}
											type="button"
											onClick={() => {
												pinMutation.mutate(
													{ tier: e.tier, provider: e.provider },
													{ onSuccess: () => setPinOpen(false) }
												);
											}}
											className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
										>
											<TierChip tier={e.tier} provider={e.provider} path={e.path} />
											<div className="min-w-0 flex-1">
												<div className="truncate font-mono text-[11px]">{e.provider}</div>
												<div className="truncate text-[10px] text-muted-foreground">{e.path}</div>
											</div>
										</button>
									))}
								</div>
							</PopoverContent>
						</Popover>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-1 pl-1">
				{entries.map((e) => (
					<SourceRow key={`${e.tier}:${e.provider}:${e.path}`} entry={e} isWinner={e === winner} />
				))}
			</div>
		</div>
	);
}

function SourceRow({ entry, isWinner }: { entry: IykeMcpEntry; isWinner: boolean }) {
	const queryClient = useQueryClient();

	const restartMutation = useMutation({
		mutationFn: async () => {
			await restartIykeMcp(entry.provider);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['project-scoped', 'iyke-mcp-list'],
			});
		},
	});

	const canRestart = entry.lifecycle === 'long-lived';
	const restartTitle = canRestart
		? `Restart ${entry.provider}'s supervised MCP children`
		: entry.lifecycle === 'per-call'
			? 'Per-call MCPs have no persistent child to restart'
			: 'On-demand MCPs are spawned by claude itself';

	return (
		<div
			className={cn(
				'flex items-center gap-2 rounded-sm px-1.5 py-1 text-[11px]',
				isWinner ? 'bg-accent/30' : ''
			)}
		>
			<TierChip tier={entry.tier} provider={entry.provider} path={entry.path} compact />
			<LifecycleChip lifecycle={entry.lifecycle} />
			<StateBadge state={entry.state} />
			{entry.transport && (
				<span className="font-mono text-[10px] text-muted-foreground">{entry.transport}</span>
			)}
			{entry.last_error && (
				<span className="truncate font-mono text-[10px] text-destructive" title={entry.last_error}>
					! {entry.last_error}
				</span>
			)}
			<div className="ml-auto flex items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					className="h-5 px-1.5 text-[10px]"
					onClick={() => restartMutation.mutate()}
					disabled={!canRestart || restartMutation.isPending}
					title={restartTitle}
				>
					<RotateCw className="mr-1 h-3 w-3" />
					{restartMutation.isPending ? 'Restarting…' : 'Restart'}
				</Button>
			</div>
		</div>
	);
}

function TierChip({
	tier,
	provider,
	path,
	compact,
}: {
	tier: IykeMcpTier;
	provider: string;
	path: string;
	compact?: boolean;
}) {
	const styles: Record<IykeMcpTier, string> = {
		personal: 'bg-muted text-muted-foreground border-border',
		workspace_pkg: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
		project: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
		project_pkg: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30',
	};
	const label = compact
		? TIER_LABEL[tier]
		: tier === 'personal'
			? 'Personal'
			: tier === 'project'
				? `Project: ${provider.replace(/^project:/, '')}`
				: tier === 'workspace_pkg'
					? `Workspace pkg: ${provider}`
					: `Project pkg: ${provider}`;
	return (
		<span
			title={path}
			className={cn(
				'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]',
				styles[tier]
			)}
		>
			{label}
		</span>
	);
}

function LifecycleChip({ lifecycle }: { lifecycle: IykeMcpEntry['lifecycle'] }) {
	const styles: Record<IykeMcpEntry['lifecycle'], string> = {
		'long-lived': 'bg-foreground/5 border-border text-foreground',
		'per-call': 'bg-muted text-muted-foreground border-border',
		'on-demand': 'bg-muted text-muted-foreground border-border',
	};
	return (
		<span
			className={cn(
				'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]',
				styles[lifecycle]
			)}
		>
			{lifecycle}
		</span>
	);
}

function StateBadge({ state }: { state: string }) {
	const lower = state.toLowerCase();
	let cls = 'bg-muted text-muted-foreground border-border';
	if (lower === 'running') {
		cls = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
	} else if (lower === 'parked') {
		cls = 'bg-muted text-muted-foreground border-border';
	} else if (lower === 'crashed') {
		cls = 'bg-destructive/10 text-destructive border-destructive/30';
	} else if (lower === 'blocked') {
		cls = 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30';
	} else if (lower === 'spawning' || lower === 'shuttingdown') {
		cls = 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30';
	}
	return (
		<span
			className={cn(
				'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]',
				cls
			)}
		>
			{state}
		</span>
	);
}
