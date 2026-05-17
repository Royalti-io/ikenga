import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import type { PaneNode, PaneView } from '@/lib/panes/types';
import { createTerminalSession } from '@/terminal/single-terminal';
import {
	Inbox,
	CheckSquare,
	Users,
	Wallet,
	Mail,
	Newspaper,
	MessageSquare,
	Terminal as TerminalIcon,
	Settings,
	FileText,
	FolderOpen,
	FolderKanban,
	RefreshCw,
	Plus,
	Layers,
	Bot,
	Pin as PinIconGlyph,
	Sparkles,
} from 'lucide-react';
import { fuzzyMatchSection, slugifySectionId, usePinsStore } from '@/lib/shell/pins-store';
import { useShellStore } from '@/lib/shell/shell-store';

export type PaletteMode = 'all' | 'views' | 'switcher' | 'projects';

interface CommandPaletteProps {
	open: boolean;
	mode: PaletteMode;
	onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, mode, onOpenChange }: CommandPaletteProps) {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	function go(to: string) {
		onOpenChange(false);
		// setTimeout so the dialog can unmount before nav fires (avoids focus
		// ping-pong between the input and the destination route).
		setTimeout(() => navigateFocused(to), 0);
	}

	function newClaudeSession() {
		onOpenChange(false);
		setTimeout(() => navigateFocused('/sessions?new=1'), 0);
	}

	/**
	 * v0 entry point for "Pin to activity bar". Pins the route currently
	 * showing in the focused pane. Uses the browser `prompt()` for label +
	 * section name to keep the surface small for this phase — the richer
	 * inline dialog (with fuzzy-match suggestion + icon picker) is a
	 * follow-up. Reserved section names are rejected at the host so a
	 * clobber attempt just shows an error toast.
	 */
	async function pinFocusedRoute() {
		const focusedId = usePaneStore.getState().focusedId;
		const leaf = findLeaf(usePaneStore.getState().root, focusedId);
		const tab = leaf?.tabs[leaf.activeTabIdx];
		if (!tab || tab.kind !== 'route') {
			onOpenChange(false);
			return;
		}
		const target = tab.path;
		const defaultLabel = target.replace(/^\//, '') || 'Home';
		const label = window.prompt('Label for the pin', defaultLabel)?.trim();
		if (!label) {
			onOpenChange(false);
			return;
		}
		const sectionInput = window
			.prompt(
				'Section name (free-form, leave blank for no section). Existing sections will be matched fuzzily.',
				''
			)
			?.trim();
		onOpenChange(false);

		const store = usePinsStore.getState();
		await store.hydrate();

		let sectionId: string | null = null;
		if (sectionInput) {
			const matched = fuzzyMatchSection(sectionInput, store.sections);
			if (matched) {
				sectionId = matched.id;
			} else {
				const candidate = slugifySectionId(sectionInput);
				if (!candidate) {
					window.alert(`'${sectionInput}' is not a valid section name.`);
					return;
				}
				const ok = window.confirm(`Create section "${sectionInput}" (id: ${candidate})?`);
				if (!ok) {
					// User said no — pin without section.
					sectionId = null;
				} else {
					try {
						const created = await store.createSection({
							id: candidate,
							label: sectionInput,
							iconLucide: 'folder',
						});
						sectionId = created.id;
					} catch (e) {
						window.alert(`Could not create section: ${String(e)}`);
						return;
					}
				}
			}
		}

		try {
			await store.addPin({
				kind: 'route',
				target,
				label,
				sectionId,
			});
		} catch (e) {
			window.alert(`Could not pin: ${String(e)}`);
		}
	}

	function addToFocused(make: () => PaneView) {
		onOpenChange(false);
		setTimeout(() => {
			const view = make();
			const focusedId = usePaneStore.getState().focusedId;
			usePaneStore.getState().addTab(focusedId, view);
		}, 0);
	}

	if (!open) return null;

	const placeholder =
		mode === 'views'
			? 'Open in focused pane…'
			: mode === 'switcher'
				? 'Switch to open tab…'
				: mode === 'projects'
					? 'Switch project…'
					: 'Type a command or search…';

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
			onClick={() => onOpenChange(false)}
		>
			<div className="absolute inset-0 bg-black/50" aria-hidden />
			<div
				className="relative w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<Command label="Command palette" className="flex flex-col">
					<Command.Input
						autoFocus
						placeholder={placeholder}
						className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
					/>
					<Command.List className="max-h-[50vh] overflow-y-auto p-2">
						<Command.Empty className="py-8 text-center text-sm text-muted-foreground">
							No results.
						</Command.Empty>

						{mode === 'switcher' ? (
							<SwitcherGroup onClose={() => onOpenChange(false)} />
						) : mode === 'projects' ? (
							<ProjectsGroup onClose={() => onOpenChange(false)} />
						) : (
							<>
								<Command.Group heading="In focused pane" className="text-xs text-muted-foreground">
									<PaletteItem
										onSelect={() =>
											addToFocused(() => ({
												kind: 'terminal',
												sessionId: createTerminalSession(),
											}))
										}
										Icon={Plus}
										label="New Terminal"
										shortcut="⌃T"
									/>
									<PaletteItem
										onSelect={() =>
											addToFocused(() => ({
												kind: 'terminal',
												sessionId: createTerminalSession({
													cmd: ['claude'],
													title: 'claude',
												}),
											}))
										}
										Icon={Plus}
										label="New Claude Terminal"
										shortcut="⌃⇧T"
									/>
									<PaletteItem
										onSelect={() => go('/projects/new-artifact')}
										Icon={Sparkles}
										label="New artifact…"
										shortcut="⌘⇧N"
									/>
									<PaletteItem
										onSelect={newClaudeSession}
										Icon={Bot}
										label="New Chat / Claude Session"
									/>
									<PaletteItem
										onSelect={() => onOpenChange(false)}
										Icon={RefreshCw}
										label="Switch Adapter (coming soon)"
										shortcut="⌘⇧A"
									/>
									<PaletteItem
										onSelect={() => onOpenChange(false)}
										Icon={FolderOpen}
										label="Open File (use Files mode for now)"
									/>
									<PaletteItem
										onSelect={() => {
											void pinFocusedRoute();
										}}
										Icon={PinIconGlyph}
										label="Pin focused route to activity bar…"
									/>
								</Command.Group>

								{mode === 'all' && (
									<Command.Group heading="Navigate" className="text-xs text-muted-foreground">
										<PaletteItem
											onSelect={() => go('/mail/inbox')}
											Icon={Inbox}
											label="Go to Inbox"
										/>
										<PaletteItem
											onSelect={() => go('/mail/triage')}
											Icon={Inbox}
											label="Go to Triage"
										/>
										<PaletteItem
											onSelect={() => go('/mail/drafts')}
											Icon={Mail}
											label="Go to Reply Drafts"
										/>
										<PaletteItem
											onSelect={() => go('/tasks')}
											Icon={CheckSquare}
											label="Go to Tasks"
										/>
										<PaletteItem
											onSelect={() => go('/pkg/com.ikenga.work/delegations')}
											Icon={Users}
											label="Go to Delegations"
										/>
										<PaletteItem
											onSelect={() => go('/finance')}
											Icon={Wallet}
											label="Go to Finance"
										/>
										<PaletteItem
											onSelect={() => go('/outbox/email')}
											Icon={Mail}
											label="Go to Outbox · Email"
										/>
										<PaletteItem
											onSelect={() => go('/outbox/newsletter')}
											Icon={Newspaper}
											label="Go to Outbox · Newsletter"
										/>
										<PaletteItem
											onSelect={() => go('/outbox/social')}
											Icon={MessageSquare}
											label="Go to Outbox · Social"
										/>
										<PaletteItem
											onSelect={() => go('/outbox/sent')}
											Icon={Mail}
											label="Go to Outbox · Sent"
										/>
										<PaletteItem
											onSelect={() => go('/sessions')}
											Icon={TerminalIcon}
											label="Go to Sessions"
										/>
										<PaletteItem
											onSelect={() => go('/settings')}
											Icon={Settings}
											label="Go to Settings"
										/>
									</Command.Group>
								)}
							</>
						)}
					</Command.List>
				</Command>
			</div>
		</div>
	);
}

interface SwitcherEntry {
	paneId: string;
	tabIdx: number;
	label: string;
	view: PaneView;
}

function collectOpenTabs(node: PaneNode): SwitcherEntry[] {
	if (node.type === 'leaf') {
		return node.tabs.map((view, tabIdx) => ({
			paneId: node.id,
			tabIdx,
			label: viewLabelShort(view),
			view,
		}));
	}
	return node.children.flatMap(collectOpenTabs);
}

function viewLabelShort(view: PaneView): string {
	switch (view.kind) {
		case 'route':
			return `Route ${view.path}`;
		case 'terminal':
			return `Terminal · ${view.sessionId.slice(0, 8)}`;
		case 'chat':
			return `Chat · ${view.sessionId.slice(0, 8)}`;
		case 'artifact':
			return `Artifact ${view.path}`;
		case 'artifact-studio':
			return 'Artifact studio';
		case 'scratchpad':
			return `Scratchpad ${view.name}`;
		case 'tool-output':
			return `Tool · ${view.toolUseId.slice(0, 8)}`;
	}
}

function SwitcherGroup({ onClose }: { onClose: () => void }) {
	const root = usePaneStore((s) => s.root);
	const focusedId = usePaneStore((s) => s.focusedId);
	const focusPane = usePaneStore((s) => s.focusPane);
	const switchTab = usePaneStore((s) => s.switchTab);

	const entries = collectOpenTabs(root);

	function focusEntry(entry: SwitcherEntry) {
		onClose();
		setTimeout(() => {
			focusPane(entry.paneId);
			switchTab(entry.paneId, entry.tabIdx);
		}, 0);
	}

	return (
		<Command.Group heading="Open tabs" className="text-xs text-muted-foreground">
			{entries.map((entry) => {
				const leaf = findLeaf(root, entry.paneId);
				const isActive =
					leaf !== null && entry.paneId === focusedId && leaf.activeTabIdx === entry.tabIdx;
				return (
					<PaletteItem
						key={`${entry.paneId}-${entry.tabIdx}`}
						onSelect={() => focusEntry(entry)}
						Icon={iconForView(entry.view)}
						label={entry.label}
						detail={isActive ? '(focused)' : `pane ${entry.paneId.slice(0, 6)}`}
					/>
				);
			})}
		</Command.Group>
	);
}

function ProjectsGroup({ onClose }: { onClose: () => void }) {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const setActiveProject = useShellStore((s) => s.setActiveProject);
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	// Active first; archived last. Match the activity-bar indicator order so
	// the palette and the popover read the same.
	const sorted = projects.slice().sort((a, b) => {
		if (a.id === activeProjectId) return -1;
		if (b.id === activeProjectId) return 1;
		const aArc = a.archived_at != null ? 1 : 0;
		const bArc = b.archived_at != null ? 1 : 0;
		if (aArc !== bArc) return aArc - bArc;
		if (a.position !== b.position) return a.position - b.position;
		return a.created_at - b.created_at;
	});

	function pick(id: string) {
		onClose();
		// Defer so the dialog can unmount before the optimistic state flip
		// triggers a re-render of the activity bar.
		setTimeout(() => {
			void setActiveProject(id);
		}, 0);
	}

	function openManage() {
		onClose();
		setTimeout(() => navigateFocused('/settings/projects'), 0);
	}

	return (
		<>
			<Command.Group heading="Projects" className="text-xs text-muted-foreground">
				{sorted.map((p) => (
					<Command.Item
						key={p.id}
						value={`${p.display_name} ${p.id} ${p.description ?? ''}`}
						onSelect={() => pick(p.id)}
						className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
					>
						<span
							aria-hidden
							className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
							style={{ background: p.color ?? '#7c7c7c' }}
						/>
						{p.icon ? (
							<span className="leading-none">{p.icon}</span>
						) : (
							<FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
						)}
						<span className="flex-1 truncate">{p.display_name}</span>
						{p.id === activeProjectId && (
							<span className="shrink-0 text-[10px] uppercase text-muted-foreground">Active</span>
						)}
						{p.archived_at != null && (
							<span className="shrink-0 text-[10px] uppercase text-muted-foreground">Archived</span>
						)}
					</Command.Item>
				))}
				{sorted.length === 0 && (
					<div className="px-3 py-3 text-xs text-muted-foreground">No projects loaded.</div>
				)}
			</Command.Group>
			<Command.Group heading="Manage" className="text-xs text-muted-foreground">
				<PaletteItem onSelect={openManage} Icon={FolderKanban} label="Open Projects settings…" />
			</Command.Group>
		</>
	);
}

function iconForView(view: PaneView): typeof Inbox {
	switch (view.kind) {
		case 'route':
			return Layers;
		case 'terminal':
			return TerminalIcon;
		case 'chat':
			return MessageSquare;
		case 'artifact':
			return FolderOpen;
		case 'artifact-studio':
			return FolderOpen;
		case 'scratchpad':
			return FileText;
		case 'tool-output':
			// No tool-call-specific icon in the icon set; FileText fits the
			// "inspecting a result" cue better than FolderOpen.
			return FileText;
	}
}

interface PaletteItemProps {
	onSelect: () => void;
	Icon: typeof Inbox;
	label: string;
	shortcut?: string;
	detail?: string;
}

function PaletteItem({ onSelect, Icon, label, shortcut, detail }: PaletteItemProps) {
	return (
		<Command.Item
			onSelect={onSelect}
			className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
		>
			<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
			<span className="flex-1 truncate">{label}</span>
			{detail && <span className="shrink-0 text-[10px] text-muted-foreground">{detail}</span>}
			{shortcut && (
				<kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
					{shortcut}
				</kbd>
			)}
		</Command.Item>
	);
}

interface PaletteState {
	open: boolean;
	mode: PaletteMode;
}

/**
 * Wires ⌘K / Ctrl+K to open the palette in 'all' mode. Other entry
 * points (⌘T views, ⌘P switcher) live in `Workspace` and call
 * `setOpen(true, mode)` on the returned controller.
 */
export function useCommandPalette() {
	const [state, setState] = useState<PaletteState>({ open: false, mode: 'all' });
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey;
			const key = e.key.toLowerCase();
			if (mod && key === 'k') {
				e.preventDefault();
				setState((s) => ({ open: !s.open, mode: 'all' }));
			} else if (mod && e.shiftKey && key === 'n') {
				e.preventDefault();
				navigateFocused('/sessions?new=1');
			} else if (e.key === 'Escape') {
				setState({ open: false, mode: 'all' });
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [navigateFocused]);

	return {
		open: state.open,
		mode: state.mode,
		setOpen: (open: boolean, mode: PaletteMode = 'all') => setState({ open, mode }),
	};
}
