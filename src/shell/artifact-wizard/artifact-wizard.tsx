// Artifact creation wizard — single-screen variant.
//
// Picks project + archetype + name, then spawns claude in the project root
// with a kickoff prompt that names the archetype and a suggested filename.
// The agent decides where the artifact lives and writes the file.
//
// The wizard is mounted by:
//   - /projects/new-artifact   (deep-link route)
//   - command palette          ("New artifact…")
//   - workspace keybinding     (⌘⇧N)
//   - sidebar empty-state CTA  (consumes the same component)
//
// Hard rule: the wizard briefs; the agent does (D4 in
// plans/shell/2026-05-17-projects-and-artifact-wizard.md).

import { useEffect, useMemo, useState } from 'react';
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
import type { Project } from '@/lib/tauri-cmd';
import {
	ARCHETYPES,
	type Archetype,
	type ArchetypeSlug,
	findArchetype,
} from '@/shell/artifact-wizard/archetypes';
import { startArtifact } from '@/shell/artifact-wizard/scaffold';

export interface ArtifactWizardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	prefill?: {
		projectId?: string | null;
		archetypeSlug?: string | null;
	};
}

export function ArtifactWizard({ open, onOpenChange, prefill }: ArtifactWizardProps) {
	const projects = useShellStore((s) => s.projects);
	const activeProjectId = useShellStore((s) => s.activeProjectId);

	const initialProjectId = useMemo(() => {
		const fromPrefill = prefill?.projectId ?? null;
		if (fromPrefill && projects.some((p) => p.id === fromPrefill)) return fromPrefill;
		return activeProjectId;
	}, [prefill?.projectId, projects, activeProjectId]);

	const [projectId, setProjectId] = useState<string>(initialProjectId);
	const [archetypeSlug, setArchetypeSlug] = useState<ArchetypeSlug | null>(
		(findArchetype(prefill?.archetypeSlug ?? null)?.slug as ArchetypeSlug | undefined) ?? null
	);
	const [name, setName] = useState<string>('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<{ kickoffPrompt: string } | null>(null);

	const project = projects.find((p) => p.id === projectId) ?? null;
	const archetype = findArchetype(archetypeSlug);

	// Re-anchor whenever the wizard opens so a cancel-then-reopen doesn't
	// surface stale state from the previous attempt.
	useEffect(() => {
		if (!open) return;
		setProjectId(initialProjectId);
		const pa = findArchetype(prefill?.archetypeSlug ?? null);
		setArchetypeSlug(pa ? (pa.slug as ArchetypeSlug) : null);
		setError(null);
		setSuccess(null);
		setSubmitting(false);
	}, [open, initialProjectId, prefill?.archetypeSlug]);

	function close() {
		onOpenChange(false);
	}

	async function submit() {
		if (!project) {
			setError('Pick a project.');
			return;
		}
		if (!archetype) {
			setError('Pick an archetype.');
			return;
		}
		if (name.trim().length === 0) {
			setError('Give the artifact a name.');
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await startArtifact({
				project,
				archetype,
				name: name.trim(),
			});
			setSuccess({ kickoffPrompt: result.kickoffPrompt });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSubmitting(false);
		}
	}

	const canSubmit = !!project && !!archetype && name.trim().length > 0;

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
						Brief claude in the project's context. The agent decides where the artifact lives and
						writes the file.
					</DialogDescription>
				</DialogHeader>

				{success ? (
					<SuccessPanel result={success} onClose={close} />
				) : (
					<div className="flex flex-col gap-4">
						<ProjectField
							projects={projects}
							projectId={projectId}
							onPick={setProjectId}
							project={project}
						/>

						<ArchetypeGrid archetype={archetype} onPick={setArchetypeSlug} />

						<NameField name={name} onChange={setName} />

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
							<Button onClick={submit} disabled={submitting || !canSubmit}>
								{submitting ? 'Starting…' : 'Start'}
							</Button>
						</>
					)}
					{success && <Button onClick={close}>Done</Button>}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Fields ──────────────────────────────────────────────────────────────

function ProjectField({
	projects,
	projectId,
	onPick,
	project,
}: {
	projects: Project[];
	projectId: string;
	onPick: (id: string) => void;
	project: Project | null;
}) {
	const usable = projects.filter((p) => p.archived_at == null);
	return (
		<div className="flex flex-col gap-1.5">
			<label className="text-xs font-medium" htmlFor="wizard-project">
				Project
			</label>
			<select
				id="wizard-project"
				className="rounded border border-border bg-background px-2 py-1.5 text-sm"
				value={projectId}
				onChange={(e) => {
					if (e.target.value === '__add__') {
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
			{project && !project.root_path && (
				<div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
					This project has no root path — the agent won't have project context. Set a root in
					Settings → Projects first.
				</div>
			)}
		</div>
	);
}

function ArchetypeGrid({
	archetype,
	onPick,
}: {
	archetype: Archetype | null;
	onPick: (slug: ArchetypeSlug) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label className="text-xs font-medium">Archetype</label>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{ARCHETYPES.map((a) => {
					const Glyph = resolveGlyph(a.glyphName);
					const active = archetype?.slug === a.slug;
					return (
						<button
							key={a.slug}
							type="button"
							onClick={() => onPick(a.slug)}
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
						</button>
					);
				})}
			</div>
		</div>
	);
}

function NameField({ name, onChange }: { name: string; onChange: (v: string) => void }) {
	return (
		<div className="flex flex-col gap-1.5">
			<label className="text-xs font-medium" htmlFor="wizard-name">
				Name
			</label>
			<input
				id="wizard-name"
				className="rounded border border-border bg-background px-2 py-1.5 text-sm"
				value={name}
				onChange={(e) => onChange(e.target.value)}
				placeholder="Q3 dashboard"
			/>
			<p className="text-[10px] text-muted-foreground">
				The agent uses this as a starting point — it can rename if needed.
			</p>
		</div>
	);
}

// ─── Success ─────────────────────────────────────────────────────────────

function SuccessPanel({
	result,
	onClose,
}: {
	result: { kickoffPrompt: string };
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
				claude spawned in a side-pane terminal. Paste the kickoff prompt below to brief it, then
				attach the terminal to a Studio loupe when the agent reports a file path.
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
			</div>
			<div className="flex justify-end">
				<Button onClick={onClose}>Done</Button>
			</div>
		</div>
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shortenPath(p: string): string {
	if (p.length <= 36) return p;
	return `…${p.slice(p.length - 35)}`;
}

type LucideIcon = (typeof Icons)['Square'];

function resolveGlyph(name: string): LucideIcon {
	const map = Icons as unknown as Record<string, LucideIcon>;
	return map[name] ?? Icons.Square;
}
