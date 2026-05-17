// Artifact creation wizard (Phase C of
// plans/shell/2026-05-17-projects-and-artifact-wizard.md).
//
// 3-step modal: project → folder + archetype (+ optional user-intent) →
// skills + agent. Stepper buttons (Back / Next / Cancel / Create). Inline
// summary stripe at the top of each step. Pre-fill via URL query params:
//
//   ?project=<id>            — pre-select project in step 1
//   &archetype=<slug>        — pre-select archetype in step 2
//   &folder=<absolute-path>  — override default subdir in step 2
//
// The wizard is mounted by:
//   - /projects/new-artifact   (deep-link route)
//   - command palette          ("New artifact…")
//   - workspace keybinding     (⌘⇧N)
//   - sidebar empty-state CTA  (Phase B; consumes the same component)
//
// Hard rule: the wizard scaffolds + spawns; the agent designs (D4).

import { useEffect, useMemo, useState } from 'react';
import { open as openTauriDialog } from '@tauri-apps/plugin-dialog';
import { useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useShellStore } from '@/lib/shell/shell-store';
import { projectSkillsList, type Project, type ProjectSkill } from '@/lib/tauri-cmd';
import {
	ARCHETYPES,
	type Archetype,
	type ArchetypeSlug,
	findArchetype,
} from '@/shell/artifact-wizard/archetypes';
import { scaffoldArtifact, type AgentChoice } from '@/shell/artifact-wizard/scaffold';

export interface ArtifactWizardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Pre-fill values. Each is honoured if it resolves; missing / invalid
	 *  values fall back to defaults. */
	prefill?: {
		projectId?: string | null;
		archetypeSlug?: string | null;
		folder?: string | null;
	};
}

type Step = 1 | 2 | 3;

const AGENT_PRESETS: AgentChoice[] = [
	{ kind: 'claude', title: 'claude', cmd: ['claude'] },
	{ kind: 'codex', title: 'codex', cmd: ['codex'] },
	{ kind: 'gemini', title: 'gemini', cmd: ['gemini'] },
];

export function ArtifactWizard({ open, onOpenChange, prefill }: ArtifactWizardProps) {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);

	const initialProjectId = useMemo(() => {
		const fromPrefill = prefill?.projectId ?? null;
		if (fromPrefill && projects.some((p) => p.id === fromPrefill)) return fromPrefill;
		return activeProjectId;
	}, [prefill?.projectId, projects, activeProjectId]);

	const [step, setStep] = useState<Step>(1);
	const [projectId, setProjectId] = useState<string>(initialProjectId);
	const [archetypeSlug, setArchetypeSlug] = useState<ArchetypeSlug | null>(
		(findArchetype(prefill?.archetypeSlug ?? null)?.slug as ArchetypeSlug | undefined) ?? null
	);
	const [folder, setFolder] = useState<string>('');
	const [folderEdited, setFolderEdited] = useState(false);
	const [name, setName] = useState<string>('');
	const [userIntent, setUserIntent] = useState<string>('');
	const [skillSelection, setSkillSelection] = useState<Set<string>>(new Set());
	const [skillsSeeded, setSkillsSeeded] = useState(false);
	const [agentKind, setAgentKind] = useState<AgentChoice['kind']>('claude');
	const [customAgentCmd, setCustomAgentCmd] = useState<string>('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<{ path: string; kickoffPrompt: string } | null>(null);

	const project = projects.find((p) => p.id === projectId) ?? null;
	const archetype = findArchetype(archetypeSlug);

	// Re-anchor the wizard whenever it (re)opens. Pre-fills win, then the
	// active project; otherwise stays at the user's last selection so a
	// canceled-then-reopened flow doesn't blow away their typing.
	useEffect(() => {
		if (!open) return;
		setStep(prefill?.archetypeSlug && prefill?.folder ? 3 : prefill?.archetypeSlug ? 2 : 1);
		setProjectId(initialProjectId);
		const pa = findArchetype(prefill?.archetypeSlug ?? null);
		if (pa) setArchetypeSlug(pa.slug);
		setFolderEdited(!!prefill?.folder);
		setError(null);
		setSuccess(null);
		setSubmitting(false);
		setSkillsSeeded(false);
		if (prefill?.folder) {
			setFolder(prefill.folder);
		}
	}, [open, initialProjectId, prefill?.archetypeSlug, prefill?.folder]);

	// Folder default derived from project root + archetype subdir. Only
	// overwrites when the user hasn't manually edited the folder field.
	useEffect(() => {
		if (folderEdited) return;
		if (!project?.root_path || !archetype) {
			setFolder('');
			return;
		}
		setFolder(joinPath(project.root_path, archetype.defaultSubdir));
	}, [project?.root_path, archetype, folderEdited]);

	const skillsQuery = useQuery({
		queryKey: ['project-skills', project?.root_path ?? null] as const,
		queryFn: () => projectSkillsList(project?.root_path ?? null, true),
		staleTime: 30_000,
		enabled: open && !!project,
	});

	// Seed skill selection from archetype defaults the first time skills
	// load for a chosen archetype. The user can toggle freely afterwards.
	useEffect(() => {
		if (!archetype || skillsSeeded) return;
		if (!skillsQuery.data) return;
		const available = new Set(skillsQuery.data.map((s) => s.slug));
		const next = new Set<string>();
		for (const slug of archetype.defaultSkills) {
			if (available.has(slug)) next.add(slug);
		}
		setSkillSelection(next);
		setSkillsSeeded(true);
	}, [archetype, skillsQuery.data, skillsSeeded]);

	function close() {
		onOpenChange(false);
	}

	function next() {
		setError(null);
		if (step === 1) {
			if (!project) {
				setError('Pick a project to continue.');
				return;
			}
			setStep(2);
			return;
		}
		if (step === 2) {
			if (!archetype) {
				setError('Pick an archetype to continue.');
				return;
			}
			if (folder.trim().length === 0) {
				setError('Folder path can not be empty.');
				return;
			}
			setStep(3);
			return;
		}
	}

	function back() {
		setError(null);
		if (step === 2) setStep(1);
		else if (step === 3) setStep(2);
	}

	async function pickFolder() {
		const picked = await openTauriDialog({
			directory: true,
			multiple: false,
			defaultPath: project?.root_path ?? undefined,
		}).catch(() => null);
		if (typeof picked === 'string' && picked.length > 0) {
			setFolder(picked);
			setFolderEdited(true);
		}
	}

	function resolveAgent(): AgentChoice {
		if (agentKind === 'custom') {
			const tokens = customAgentCmd.trim().split(/\s+/).filter(Boolean);
			return { kind: 'custom', title: tokens[0] ?? 'agent', cmd: tokens };
		}
		const preset = AGENT_PRESETS.find((a) => a.kind === agentKind);
		return preset ?? AGENT_PRESETS[0];
	}

	async function submit() {
		if (!project || !archetype) return;
		if (name.trim().length === 0) {
			setError('Give the artifact a name.');
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await scaffoldArtifact({
				project,
				folder: folder.trim(),
				archetype,
				skills: [...skillSelection],
				agent: resolveAgent(),
				name: name.trim(),
				userIntent,
			});
			setSuccess({ path: result.path, kickoffPrompt: result.kickoffPrompt });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-2xl"
				onEscapeKeyDown={(e) => {
					if (submitting) e.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>New artifact</DialogTitle>
					<DialogDescription>
						Scaffold an HTML artifact and brief an agent in the project's context.
					</DialogDescription>
				</DialogHeader>

				<SummaryStripe
					step={step}
					project={project}
					archetype={archetype}
					folder={folder}
					skillsCount={skillSelection.size}
					agentKind={agentKind}
				/>

				{success ? (
					<SuccessPanel result={success} onClose={close} />
				) : (
					<div className="flex flex-col gap-4">
						{step === 1 && (
							<StepProject projects={projects} projectId={projectId} onPick={setProjectId} />
						)}
						{step === 2 && (
							<StepFolderArchetype
								folder={folder}
								onFolderChange={(v) => {
									setFolder(v);
									setFolderEdited(true);
								}}
								onPickFolder={pickFolder}
								archetype={archetype}
								onPickArchetype={(slug) => {
									setArchetypeSlug(slug);
									setSkillsSeeded(false);
								}}
								userIntent={userIntent}
								onUserIntentChange={setUserIntent}
								projectRoot={project?.root_path ?? null}
							/>
						)}
						{step === 3 && archetype && (
							<StepSkillsAgent
								name={name}
								onNameChange={setName}
								skills={skillsQuery.data ?? []}
								loading={skillsQuery.isLoading}
								selected={skillSelection}
								onToggle={(slug) => {
									setSkillSelection((cur) => {
										const next = new Set(cur);
										if (next.has(slug)) next.delete(slug);
										else next.add(slug);
										return next;
									});
								}}
								agentKind={agentKind}
								onAgentKindChange={setAgentKind}
								customAgentCmd={customAgentCmd}
								onCustomAgentCmdChange={setCustomAgentCmd}
							/>
						)}

						{error && (
							<div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
								{error}
							</div>
						)}
					</div>
				)}

				<DialogFooter className="mt-2">
					{!success && (
						<>
							<Button variant="ghost" onClick={close} disabled={submitting}>
								Cancel
							</Button>
							{step > 1 && (
								<Button variant="outline" onClick={back} disabled={submitting}>
									Back
								</Button>
							)}
							{step < 3 ? (
								<Button onClick={next}>Next</Button>
							) : (
								<Button onClick={submit} disabled={submitting}>
									{submitting ? 'Creating…' : 'Create'}
								</Button>
							)}
						</>
					)}
					{success && <Button onClick={close}>Done</Button>}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Summary stripe ──────────────────────────────────────────────────────

function SummaryStripe({
	step,
	project,
	archetype,
	folder,
	skillsCount,
	agentKind,
}: {
	step: Step;
	project: Project | null;
	archetype: Archetype | null;
	folder: string;
	skillsCount: number;
	agentKind: AgentChoice['kind'];
}) {
	const items: Array<{ label: string; value: string; active: boolean }> = [
		{
			label: 'Project',
			value: project?.display_name ?? '—',
			active: step === 1,
		},
		{
			label: 'Archetype',
			value: archetype?.label ?? '—',
			active: step === 2,
		},
		{
			label: 'Folder',
			value: folder ? shortenPath(folder) : '—',
			active: step === 2,
		},
		{
			label: 'Skills',
			value: skillsCount > 0 ? `${skillsCount}` : '—',
			active: step === 3,
		},
		{
			label: 'Agent',
			value: agentKind,
			active: step === 3,
		},
	];
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 rounded border border-border bg-muted/30 px-3 py-2 text-[11px]">
			{items.map((it) => (
				<div key={it.label} className="flex items-baseline gap-1">
					<span
						className={cn(
							'font-mono uppercase tracking-wider',
							it.active ? 'text-foreground' : 'text-muted-foreground'
						)}
					>
						{it.label}:
					</span>
					<span className={cn(it.active ? 'text-foreground' : 'text-muted-foreground/80')}>
						{it.value}
					</span>
				</div>
			))}
		</div>
	);
}

// ─── Step 1: project ─────────────────────────────────────────────────────

function StepProject({
	projects,
	projectId,
	onPick,
}: {
	projects: Project[];
	projectId: string;
	onPick: (id: string) => void;
}) {
	const usable = projects.filter((p) => p.archived_at == null);
	return (
		<div className="flex flex-col gap-2">
			<label className="text-xs font-medium" htmlFor="wizard-project">
				Project
			</label>
			<select
				id="wizard-project"
				className="rounded border border-border bg-background px-2 py-1.5 text-sm"
				value={projectId}
				onChange={(e) => {
					if (e.target.value === '__add__') {
						// Delegate to Settings → Projects (Phase A).
						window.location.hash = '#/settings/projects';
						return;
					}
					onPick(e.target.value);
				}}
			>
				{usable.map((p) => (
					<option key={p.id} value={p.id}>
						{p.display_name}
						{p.root_path ? ` · ${shortenPath(p.root_path)}` : ' · no root'}
					</option>
				))}
				<option value="__add__">+ Add new project…</option>
			</select>
			<p className="text-[11px] text-muted-foreground">
				The chosen project's <code>.claude/</code> defines which skills, commands, and MCP servers
				your agent sees. Defaults to the active project.
			</p>
		</div>
	);
}

// ─── Step 2: folder + archetype ──────────────────────────────────────────

function StepFolderArchetype({
	folder,
	onFolderChange,
	onPickFolder,
	archetype,
	onPickArchetype,
	userIntent,
	onUserIntentChange,
	projectRoot,
}: {
	folder: string;
	onFolderChange: (v: string) => void;
	onPickFolder: () => void;
	archetype: Archetype | null;
	onPickArchetype: (slug: ArchetypeSlug) => void;
	userIntent: string;
	onUserIntentChange: (v: string) => void;
	projectRoot: string | null;
}) {
	const outsideProject =
		!!projectRoot && folder.length > 0 && !folder.startsWith(projectRoot.replace(/\/+$/, ''));
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium">Archetype</label>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{ARCHETYPES.map((a) => {
						const Glyph = resolveGlyph(a.glyphName);
						const active = archetype?.slug === a.slug;
						return (
							<button
								key={a.slug}
								type="button"
								onClick={() => onPickArchetype(a.slug)}
								className={cn(
									'flex flex-col items-start gap-1 rounded border px-3 py-2 text-left transition-colors',
									active
										? 'border-foreground bg-accent text-accent-foreground'
										: 'border-border bg-background hover:bg-muted/30'
								)}
							>
								<div className="flex items-center gap-1.5 text-sm font-medium">
									<Glyph className="h-4 w-4" />
									<span>{a.label}</span>
								</div>
								<p className="text-[10px] leading-snug text-muted-foreground">{a.description}</p>
								<div className="mt-0.5 font-mono text-[9px] text-muted-foreground/80">
									{a.viewport.w}×{a.viewport.h}
								</div>
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium" htmlFor="wizard-folder">
					Folder
				</label>
				<div className="flex items-center gap-2">
					<input
						id="wizard-folder"
						className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
						value={folder}
						onChange={(e) => onFolderChange(e.target.value)}
						placeholder="/absolute/path"
					/>
					<Button variant="outline" size="sm" onClick={onPickFolder}>
						Browse…
					</Button>
				</div>
				{outsideProject && (
					<div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
						Folder is outside the project root — the agent won't have project context.
					</div>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium" htmlFor="wizard-intent">
					What are you building? <span className="text-muted-foreground">(optional)</span>
				</label>
				<textarea
					id="wizard-intent"
					rows={2}
					className="rounded border border-border bg-background px-2 py-1.5 text-xs"
					value={userIntent}
					onChange={(e) => onUserIntentChange(e.target.value)}
					placeholder="Short intent — the agent uses this to pick a starting structure."
				/>
			</div>
		</div>
	);
}

// ─── Step 3: skills + agent ──────────────────────────────────────────────

function StepSkillsAgent({
	name,
	onNameChange,
	skills,
	loading,
	selected,
	onToggle,
	agentKind,
	onAgentKindChange,
	customAgentCmd,
	onCustomAgentCmdChange,
}: {
	name: string;
	onNameChange: (v: string) => void;
	skills: ProjectSkill[];
	loading: boolean;
	selected: Set<string>;
	onToggle: (slug: string) => void;
	agentKind: AgentChoice['kind'];
	onAgentKindChange: (k: AgentChoice['kind']) => void;
	customAgentCmd: string;
	onCustomAgentCmdChange: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium" htmlFor="wizard-name">
					Name
				</label>
				<input
					id="wizard-name"
					className="rounded border border-border bg-background px-2 py-1.5 text-sm"
					value={name}
					onChange={(e) => onNameChange(e.target.value)}
					placeholder="Q3 dashboard"
				/>
				<p className="text-[10px] text-muted-foreground">
					Becomes <code>&lt;slug&gt;.html</code> in the chosen folder.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium">Skills</label>
				{loading ? (
					<div className="rounded border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
						Loading skills…
					</div>
				) : skills.length === 0 ? (
					<div className="rounded border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
						No skills found. The agent will run without skill hints.
					</div>
				) : (
					<div className="max-h-48 overflow-y-auto rounded border border-border bg-background">
						<ul>
							{skills.map((s) => {
								const checked = selected.has(s.slug);
								return (
									<li key={`${s.source}:${s.slug}`}>
										<label className="flex cursor-pointer items-start gap-2 border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-muted/20">
											<input
												type="checkbox"
												checked={checked}
												onChange={() => onToggle(s.slug)}
												className="mt-0.5"
											/>
											<span className="flex-1 min-w-0">
												<span className="flex items-center gap-1.5 text-xs">
													<span className="font-medium">{s.name ?? s.slug}</span>
													<span
														className={cn(
															'rounded px-1 font-mono text-[9px] uppercase tracking-wider',
															s.source === 'project'
																? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
																: 'bg-muted text-muted-foreground'
														)}
													>
														{s.source}
													</span>
												</span>
												{s.description && (
													<span className="block truncate text-[10px] text-muted-foreground">
														{s.description}
													</span>
												)}
											</span>
										</label>
									</li>
								);
							})}
						</ul>
					</div>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium">Agent</label>
				<div className="flex flex-wrap gap-1.5">
					{(['claude', 'codex', 'gemini', 'custom'] as const).map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => onAgentKindChange(k)}
							className={cn(
								'rounded border px-2 py-1 text-xs',
								agentKind === k
									? 'border-foreground bg-accent text-accent-foreground'
									: 'border-border bg-background hover:bg-muted/30'
							)}
						>
							{k}
						</button>
					))}
				</div>
				{agentKind === 'custom' && (
					<input
						className="rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
						placeholder="e.g. /usr/local/bin/my-agent --flag"
						value={customAgentCmd}
						onChange={(e) => onCustomAgentCmdChange(e.target.value)}
					/>
				)}
				<p className="text-[10px] text-muted-foreground">
					Spawned in a terminal at the project root. Attach it to the Studio rail from the loupe
					chrome after the wizard closes.
				</p>
			</div>
		</div>
	);
}

// ─── Success panel ───────────────────────────────────────────────────────

function SuccessPanel({
	result,
	onClose,
}: {
	result: { path: string; kickoffPrompt: string };
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);
	function copy() {
		void navigator.clipboard
			.writeText(result.kickoffPrompt)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	}
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
				Scaffolded <code className="font-mono">{result.path}</code>. The loupe is now open on the
				file and a terminal was spawned in the side pane — attach it from the loupe chrome.
			</div>
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between">
					<label className="text-xs font-medium">Kickoff prompt</label>
					<Button size="sm" variant="outline" onClick={copy}>
						{copied ? 'Copied' : 'Copy'}
					</Button>
				</div>
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
					{result.kickoffPrompt}
				</pre>
				<p className="text-[10px] text-muted-foreground">
					Paste into the attached terminal so the agent picks up the brief.
				</p>
			</div>
			<div className="flex justify-end">
				<Button onClick={onClose}>Done</Button>
			</div>
		</div>
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function joinPath(folder: string, name: string): string {
	const cleaned = folder.replace(/\/+$/, '');
	return `${cleaned}/${name}`;
}

function shortenPath(p: string): string {
	if (p.length <= 36) return p;
	return `…${p.slice(p.length - 35)}`;
}

type LucideIcon = (typeof Icons)['Square'];

function resolveGlyph(name: string): LucideIcon {
	const map = Icons as unknown as Record<string, LucideIcon>;
	return map[name] ?? Icons.Square;
}
