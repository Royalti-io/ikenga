// Phase 0 (projects-first-class) — Settings → Projects.
//
// CRUD + archive surface for the durable `projects` table (migration 0015).
// Per the plan, this replaces the old "Claude project roots" section in
// Storage. The active-project switcher lives in the activity bar and the
// ⌘P command palette; this route is for management only.

import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Archive, FolderOpen, FolderPlus, Pencil, Plus, RotateCcw } from 'lucide-react';

import { iykeLayoutReset } from '@/lib/iyke/layout';

import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/components/ui/utils';
import { useShellStore } from '@/lib/shell/shell-store';
import {
	type Project,
	type ProjectCreateArgs,
	projectArchive,
	projectCreate,
	projectUpdate,
} from '@/lib/tauri-cmd';

// Default-project slug is reserved by Rust (`is_default = 1`). Refuse archive
// from the FE too so the user sees an explanatory error instead of round-
// tripping a 500.
const DEFAULT_ID = 'default';

// A small palette to seed the picker — users can paste any 7-char hex too.
const PRESET_COLORS = [
	'#7c7c7c',
	'#4f8cff',
	'#22c55e',
	'#f97316',
	'#a855f7',
	'#ef4444',
	'#14b8a6',
	'#eab308',
];

function ProjectsPage() {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const refreshProjects = useShellStore((s) => s.refreshProjects);
	const [editing, setEditing] = useState<Project | null>(null);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const visible = projects.slice().sort((a, b) => {
		// Archived last; otherwise honor position then created_at.
		const aArc = a.archived_at != null ? 1 : 0;
		const bArc = b.archived_at != null ? 1 : 0;
		if (aArc !== bArc) return aArc - bArc;
		if (a.position !== b.position) return a.position - b.position;
		return a.created_at - b.created_at;
	});

	async function handleArchive(project: Project) {
		if (project.id === DEFAULT_ID) {
			setError('The Default project cannot be archived.');
			return;
		}
		const ok = window.confirm(
			`Archive "${project.display_name}"? Its data is preserved but it will be hidden from the switcher.`
		);
		if (!ok) return;
		try {
			await projectArchive(project.id);
			await refreshProjects();
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function handleResetLayout(project: Project) {
		const ok = window.confirm(
			`Reset saved pane layout for "${project.display_name}"? The next time you switch to this project, it will adopt whatever pane arrangement is currently visible. Chats, files, and other state are not affected.`
		);
		if (!ok) return;
		try {
			await iykeLayoutReset(project.id);
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center gap-3 border-b border-border-soft px-6 text-xs text-muted-foreground">
				<span>
					Settings · <span className="font-semibold text-foreground">Projects</span>
				</span>
			</div>

			<div className="flex-1 overflow-y-auto px-6 py-6">
				<div className="mx-auto max-w-3xl space-y-6">
					<header className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<h2
								className="text-2xl font-semibold tracking-tight"
								style={{ fontFamily: 'var(--font-display)' }}
							>
								Projects
							</h2>
							<p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
								First-class scoping containers for chats, packages, layout, memory, and todos.
								Switch the active project from the activity bar or with <kbd>⌘P</kbd>. The Default
								project is built in and cannot be archived.
							</p>
						</div>
						<Button size="sm" onClick={() => setCreating(true)}>
							<Plus className="mr-1 h-3.5 w-3.5" />
							New project
						</Button>
					</header>

					{error && (
						<div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
							{error}
						</div>
					)}

					<section className="overflow-hidden rounded-lg border border-[var(--border-soft)] bg-card">
						<header className="grid grid-cols-[2fr_1.5fr_1fr_auto] items-center gap-3 border-b border-[var(--border-soft)] bg-[var(--bg-sunken)] px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							<span>Project</span>
							<span>Root path</span>
							<span>Slug</span>
							<span className="sr-only">Actions</span>
						</header>
						<ul className="divide-y divide-border">
							{visible.length === 0 && (
								<li className="px-4 py-6 text-center text-sm text-muted-foreground">
									Loading projects…
								</li>
							)}
							{visible.map((p) => (
								<li
									key={p.id}
									className={cn(
										'grid grid-cols-[2fr_1.5fr_1fr_auto] items-center gap-3 px-4 py-2.5 text-sm',
										p.archived_at != null && 'opacity-60'
									)}
								>
									<div className="flex items-center gap-2 min-w-0">
										<span
											aria-hidden
											className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
											style={{ background: p.color ?? '#7c7c7c' }}
										/>
										{p.icon && <span className="text-base leading-none">{p.icon}</span>}
										<span className="truncate font-medium text-foreground">{p.display_name}</span>
										{p.id === activeProjectId && (
											<span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase text-primary">
												Active
											</span>
										)}
										{p.is_default && (
											<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
												Default
											</span>
										)}
										{p.archived_at != null && (
											<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
												Archived
											</span>
										)}
									</div>
									<div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
										{p.root_path ?? <span className="italic">(none)</span>}
									</div>
									<div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
										{p.id}
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setEditing(p)}
											aria-label={`Edit ${p.display_name}`}
										>
											<Pencil className="h-3.5 w-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => void handleResetLayout(p)}
											disabled={p.archived_at != null}
											aria-label={`Reset layout for ${p.display_name}`}
											title="Reset saved pane layout for this project"
										>
											<RotateCcw className="h-3.5 w-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => void handleArchive(p)}
											disabled={p.is_default || p.archived_at != null}
											aria-label={`Archive ${p.display_name}`}
											className="text-muted-foreground hover:text-red-700"
										>
											<Archive className="h-3.5 w-3.5" />
										</Button>
									</div>
								</li>
							))}
						</ul>
					</section>
				</div>
			</div>

			{creating && (
				<ProjectDialog
					project={null}
					onClose={() => {
						setCreating(false);
						setError(null);
					}}
					onSaved={async () => {
						setCreating(false);
						await refreshProjects();
					}}
				/>
			)}
			{editing && (
				<ProjectDialog
					project={editing}
					onClose={() => {
						setEditing(null);
						setError(null);
					}}
					onSaved={async () => {
						setEditing(null);
						await refreshProjects();
					}}
				/>
			)}
		</div>
	);
}

interface ProjectDialogProps {
	project: Project | null;
	onClose: () => void;
	onSaved: () => Promise<void> | void;
}

function ProjectDialog({ project, onClose, onSaved }: ProjectDialogProps) {
	const isEdit = project !== null;
	const [displayName, setDisplayName] = useState(project?.display_name ?? '');
	const [slug, setSlug] = useState(project?.id ?? '');
	const [rootPath, setRootPath] = useState(project?.root_path ?? '');
	const [icon, setIcon] = useState(project?.icon ?? '');
	const [color, setColor] = useState(project?.color ?? PRESET_COLORS[0]);
	const [description, setDescription] = useState(project?.description ?? '');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Naive slug auto-derive while creating (only if user hasn't typed one).
	const slugTouched = isEdit || slug.length > 0;
	function handleDisplayNameChange(next: string) {
		setDisplayName(next);
		if (!slugTouched && !isEdit) {
			setSlug(
				next
					.toLowerCase()
					.trim()
					.replace(/[^a-z0-9_-]+/g, '-')
					.replace(/^-+|-+$/g, '')
					.slice(0, 64)
			);
		}
	}

	async function pickRoot() {
		const picked = await openDialog({ directory: true, multiple: false });
		if (typeof picked === 'string') setRootPath(picked);
	}

	async function handleSave() {
		setBusy(true);
		setError(null);
		try {
			if (isEdit && project) {
				await projectUpdate(project.id, {
					display_name: displayName.trim(),
					root_path: rootPath.trim() || null,
					icon: icon.trim() || null,
					color: color || null,
					description: description.trim() || null,
				});
			} else {
				const args: ProjectCreateArgs = {
					id: slug.trim(),
					display_name: displayName.trim(),
					root_path: rootPath.trim() || null,
					icon: icon.trim() || null,
					color: color || null,
					description: description.trim() || null,
				};
				await projectCreate(args);
			}
			await onSaved();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const canSave =
		displayName.trim().length > 0 && (isEdit || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug.trim()));

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{isEdit ? 'Edit project' : 'New project'}</DialogTitle>
					<DialogDescription>
						{isEdit
							? 'Update this project — slug is immutable.'
							: 'Projects scope chats, pkgs, layout, memory, and todos.'}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="space-y-1">
						<label className="text-xs font-medium text-muted-foreground">Display name</label>
						<Input
							value={displayName}
							onChange={(e) => handleDisplayNameChange(e.target.value)}
							placeholder="Royalti Web"
							autoFocus
						/>
					</div>

					<div className="space-y-1">
						<label className="text-xs font-medium text-muted-foreground">
							Slug{!isEdit && <span className="text-destructive"> *</span>}
						</label>
						<Input
							value={slug}
							onChange={(e) => setSlug(e.target.value)}
							placeholder="royalti-web"
							disabled={isEdit}
							spellCheck={false}
							className="font-mono"
						/>
						{!isEdit && (
							<p className="text-[11px] text-muted-foreground">
								Lowercase letters, digits, <code>-</code>, <code>_</code>. Max 64 chars. Used as the
								project id everywhere.
							</p>
						)}
					</div>

					<div className="space-y-1">
						<label className="text-xs font-medium text-muted-foreground">
							Root path (optional)
						</label>
						<div className="flex gap-2">
							<Input
								value={rootPath}
								onChange={(e) => setRootPath(e.target.value)}
								placeholder="/home/me/code/project"
								spellCheck={false}
								className="font-mono text-xs"
							/>
							<Button type="button" variant="outline" size="sm" onClick={() => void pickRoot()}>
								<FolderOpen className="h-3.5 w-3.5" />
							</Button>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<label className="text-xs font-medium text-muted-foreground">Icon (emoji)</label>
							<Input
								value={icon}
								onChange={(e) => setIcon(e.target.value)}
								placeholder="🎵"
								maxLength={8}
							/>
						</div>
						<div className="space-y-1">
							<label className="text-xs font-medium text-muted-foreground">Color</label>
							<div className="flex items-center gap-2">
								<input
									type="color"
									value={color}
									onChange={(e) => setColor(e.target.value)}
									className="h-9 w-9 cursor-pointer rounded border border-input bg-transparent"
									aria-label="Project color"
								/>
								<div className="flex flex-wrap gap-1">
									{PRESET_COLORS.map((c) => (
										<button
											key={c}
											type="button"
											onClick={() => setColor(c)}
											className={cn(
												'h-5 w-5 rounded-full border border-border transition-transform',
												color === c && 'scale-110 ring-2 ring-ring'
											)}
											style={{ background: c }}
											aria-label={`Pick ${c}`}
										/>
									))}
								</div>
							</div>
						</div>
					</div>

					<div className="space-y-1">
						<label className="text-xs font-medium text-muted-foreground">Description</label>
						<Input
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="What lives here?"
						/>
					</div>

					{error && <p className="text-xs text-red-700">{error}</p>}
				</div>

				<DialogFooter className="flex-row sm:justify-end">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button size="sm" onClick={() => void handleSave()} disabled={busy || !canSave}>
						{isEdit ? (
							<>
								<Pencil className="mr-1 h-3.5 w-3.5" />
								Save
							</>
						) : (
							<>
								<FolderPlus className="mr-1 h-3.5 w-3.5" />
								Create
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export const Route = createFileRoute('/settings/projects')({
	component: ProjectsPage,
});
