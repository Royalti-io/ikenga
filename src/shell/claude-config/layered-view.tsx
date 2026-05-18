// Phase 4 — Claude Config Browser "Layered View".
//
// Renders the 4-tier discovery tree (skills/agents/commands/hooks/mcps),
// surfaces conflicts (entries with multiple sources), and lets users pin a
// preferred tier+source per asset. The legacy 2-tier "Roots View" is kept
// alongside this in `routes/claude/route.tsx`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	Bot,
	ChevronDown,
	ChevronRight,
	FileText,
	FolderKanban,
	Pin,
	PinOff,
	Plug,
	Terminal,
	Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/components/ui/utils';
import { claudeAssetPinsQueryOptions, claudeAssetsQueryOptions } from '@/lib/queries/claude';
import { useShellStore } from '@/lib/shell/shell-store';
import {
	claudeAssetPin,
	claudeAssetUnpin,
	type ClaudeAssetKind,
	type ClaudeAssetPin,
	type ClaudeAssetSource,
	type ClaudeAssetTier,
	type ClaudeAssetTree,
	type Project,
} from '@/lib/tauri-cmd';

const KIND_ORDER: Array<{
	key: keyof ClaudeAssetTree;
	kind: ClaudeAssetKind;
	label: string;
	icon: typeof Bot;
}> = [
	{ key: 'skills', kind: 'skill', label: 'Skills', icon: Zap },
	{ key: 'agents', kind: 'agent', label: 'Agents', icon: Bot },
	{ key: 'commands', kind: 'command', label: 'Commands', icon: Terminal },
	{ key: 'hooks', kind: 'hook', label: 'Hooks', icon: FileText },
	{ key: 'mcps', kind: 'mcp', label: 'MCPs', icon: Plug },
];

const TIER_LABEL: Record<ClaudeAssetTier, string> = {
	personal: 'Personal',
	workspace_pkg: 'Workspace pkg',
	project: 'Project',
	project_pkg: 'Project pkg',
};

// Conflict ordering uses the same tier precedence the Rust core applies: the
// lower-indexed tier wins by default unless a pin overrides.
const TIER_RANK: Record<ClaudeAssetTier, number> = {
	personal: 3,
	workspace_pkg: 2,
	project: 1,
	project_pkg: 0,
};

export function LayeredView() {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const [selectedProjectId, setSelectedProjectId] = useState<string>(activeProjectId);

	const scope = `project:${selectedProjectId}`;
	const treeQuery = useQuery(claudeAssetsQueryOptions(selectedProjectId));
	const pinsQuery = useQuery(claudeAssetPinsQueryOptions(scope));

	const pinByKey = useMemo(() => {
		const m = new Map<string, ClaudeAssetPin>();
		for (const p of pinsQuery.data ?? []) {
			m.set(`${p.asset_kind}:${p.asset_name}`, p);
		}
		return m;
	}, [pinsQuery.data]);

	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	const conflictCount = useMemo(() => {
		if (!treeQuery.data) return 0;
		let n = 0;
		for (const { key } of KIND_ORDER) {
			for (const sources of Object.values(treeQuery.data[key])) {
				if (sources.length > 1) n += 1;
			}
		}
		return n;
	}, [treeQuery.data]);

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
					{treeQuery.isLoading && <span>Loading…</span>}
					{conflictCount > 0 && (
						<Badge variant="outline" className="border-amber-400/60 text-amber-600">
							{conflictCount} conflict{conflictCount === 1 ? '' : 's'}
						</Badge>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto px-4 py-3">
				{treeQuery.error && (
					<div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
						Failed to discover assets: {String(treeQuery.error)}
					</div>
				)}
				{treeQuery.data && (
					<div className="space-y-3">
						{KIND_ORDER.map(({ key, kind, label, icon }) => (
							<KindGroup
								key={key}
								label={label}
								icon={icon}
								kind={kind}
								scope={scope}
								entries={treeQuery.data[key]}
								pinByKey={pinByKey}
							/>
						))}
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

function KindGroup({
	label,
	icon: Icon,
	kind,
	scope,
	entries,
	pinByKey,
}: {
	label: string;
	icon: typeof Bot;
	kind: ClaudeAssetKind;
	scope: string;
	entries: Record<string, ClaudeAssetSource[]>;
	pinByKey: Map<string, ClaudeAssetPin>;
}) {
	const [open, setOpen] = useState(true);
	const names = Object.keys(entries).sort((a, b) => a.localeCompare(b));
	const conflicts = names.filter((n) => entries[n]!.length > 1).length;

	return (
		<div className="rounded-md border border-border bg-card">
			<button
				type="button"
				onClick={() => setOpen((x) => !x)}
				className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-accent/30"
			>
				{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				<Icon className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="font-medium">{label}</span>
				<span className="font-mono text-[10px] text-muted-foreground">{names.length}</span>
				{conflicts > 0 && (
					<Badge variant="outline" className="ml-1 border-amber-400/60 text-amber-600">
						{conflicts} conflict{conflicts === 1 ? '' : 's'}
					</Badge>
				)}
			</button>
			{open && (
				<div className="divide-y divide-border">
					{names.length === 0 && (
						<div className="px-3 py-3 text-xs text-muted-foreground">No {label.toLowerCase()}.</div>
					)}
					{names.map((name) => (
						<AssetRow
							key={name}
							name={name}
							kind={kind}
							scope={scope}
							sources={entries[name]!}
							pin={pinByKey.get(`${kind}:${name}`)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function AssetRow({
	name,
	kind,
	scope,
	sources,
	pin,
}: {
	name: string;
	kind: ClaudeAssetKind;
	scope: string;
	sources: ClaudeAssetSource[];
	pin: ClaudeAssetPin | undefined;
}) {
	const queryClient = useQueryClient();

	// Effective source: the pin wins if it matches an available source;
	// otherwise the lowest-tier-rank source is the default winner.
	const sorted = [...sources].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
	const winner = useMemo(() => {
		if (pin) {
			const match = sources.find(
				(s) =>
					s.tier === pin.preferred_tier &&
					(pin.preferred_source ? s.provider === pin.preferred_source : true)
			);
			if (match) return match;
		}
		return sorted[0]!;
	}, [pin, sources, sorted]);

	const others = sorted.filter((s) => s !== winner);
	const isConflict = sources.length > 1;

	const pinMutation = useMutation({
		mutationFn: async (args: { tier: ClaudeAssetTier; provider: string | null }) => {
			await claudeAssetPin(scope, kind, name, args.tier, args.provider);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['project-scoped', 'claude-asset-pins', { scope }],
			});
		},
	});

	const unpinMutation = useMutation({
		mutationFn: async () => {
			await claudeAssetUnpin(scope, kind, name);
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
				<TierChip source={winner} />
				{isConflict && (
					<Badge
						variant="outline"
						className="border-amber-400/60 text-[10px] text-amber-600"
						title={others.map((s) => `${TIER_LABEL[s.tier]} · ${s.provider}`).join('\n')}
					>
						Also in: {others.map((s) => TIER_LABEL[s.tier]).join(', ')}
					</Badge>
				)}
				<div className="ml-auto flex items-center gap-1">
					{pin && (
						<span className="font-mono text-[10px] text-muted-foreground">
							Pinned to {TIER_LABEL[pin.preferred_tier]}
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
									{sorted.map((s) => (
										<button
											key={`${s.tier}:${s.provider}:${s.path}`}
											type="button"
											onClick={() => {
												pinMutation.mutate(
													{ tier: s.tier, provider: s.provider },
													{
														onSuccess: () => setPinOpen(false),
													}
												);
											}}
											className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
										>
											<TierChip source={s} />
											<div className="min-w-0 flex-1">
												<div className="truncate font-mono text-[11px]">{s.provider}</div>
												<div className="truncate text-[10px] text-muted-foreground">{s.path}</div>
											</div>
										</button>
									))}
								</div>
							</PopoverContent>
						</Popover>
					)}
				</div>
			</div>
		</div>
	);
}

function TierChip({ source }: { source: ClaudeAssetSource }) {
	const { tier, provider } = source;
	const styles: Record<ClaudeAssetTier, string> = {
		personal: 'bg-muted text-muted-foreground border-border',
		workspace_pkg: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
		project: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
		project_pkg: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30',
	};
	const label =
		tier === 'personal'
			? 'Personal'
			: tier === 'project'
				? `Project: ${provider.replace(/^project:/, '')}`
				: tier === 'workspace_pkg'
					? `Workspace pkg: ${provider}`
					: `Project pkg: ${provider}`;
	return (
		<span
			title={source.path}
			className={cn(
				'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]',
				styles[tier]
			)}
		>
			{label}
		</span>
	);
}
