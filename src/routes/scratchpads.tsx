// Scratchpads index — list view for the active project's scratchpads.
// Clicking opens the scratchpad as a `kind: 'scratchpad'` tab in the
// focused pane. New-scratchpad composer creates an empty entry and
// switches to it.

import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deleteScratchpad, listScratchpads, writeScratchpad } from '@/lib/iyke/memory';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useShellStore } from '@/lib/shell/shell-store';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,119}$/;

function ScratchpadsPage() {
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const scope = `project:${activeProjectId}`;
	const qc = useQueryClient();
	const [composer, setComposer] = useState('');
	const [composerError, setComposerError] = useState<string | null>(null);

	const list = useQuery({
		queryKey: ['project-scoped', 'scratchpads', scope],
		queryFn: () => listScratchpads(scope),
	});

	const createMut = useMutation({
		mutationFn: (name: string) => writeScratchpad(name, '', scope),
		onSuccess: (_res, name) => {
			void qc.invalidateQueries({ queryKey: ['project-scoped', 'scratchpads', scope] });
			openInPane(scope, name);
			setComposer('');
		},
		onError: (e: unknown) => {
			setComposerError(e instanceof Error ? e.message : String(e));
		},
	});

	const deleteMut = useMutation({
		mutationFn: (name: string) => deleteScratchpad(name, scope),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['project-scoped', 'scratchpads', scope] });
		},
	});

	function openInPane(scopeKey: string, name: string) {
		const store = usePaneStore.getState();
		store.addTab(store.focusedId, { kind: 'scratchpad', scope: scopeKey, name });
	}

	function handleCreate() {
		const trimmed = composer.trim();
		if (!trimmed) {
			setComposerError('name required');
			return;
		}
		if (!SLUG_RE.test(trimmed)) {
			setComposerError('use letters/digits/._- and start alphanumeric');
			return;
		}
		setComposerError(null);
		createMut.mutate(trimmed);
	}

	return (
		<div className="flex h-full flex-col bg-background">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-baseline justify-between">
					<h1 className="text-lg font-semibold">Scratchpads</h1>
					<div className="font-mono text-xs text-muted-foreground">{scope}</div>
				</div>
				<p className="mt-1 text-sm text-muted-foreground">
					Project-scoped, zero-structure notes. Anything an agent or you can write — plans,
					handoffs, working context — that should outlive a chat.
				</p>
			</div>

			<div className="border-b border-border px-4 py-3">
				<div className="flex gap-2">
					<Input
						placeholder="new-scratchpad-name"
						value={composer}
						onChange={(e) => setComposer(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleCreate();
							}
						}}
						className="font-mono"
					/>
					<Button onClick={handleCreate} disabled={createMut.isPending}>
						<Plus className="mr-1 h-4 w-4" />
						{createMut.isPending ? 'Creating…' : 'New'}
					</Button>
				</div>
				{composerError && <div className="mt-1 text-xs text-destructive">{composerError}</div>}
			</div>

			<div className="flex-1 overflow-y-auto">
				{list.isLoading && <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>}
				{list.error && (
					<div className="px-4 py-3 text-sm text-destructive">{(list.error as Error).message}</div>
				)}
				{list.data && list.data.scratchpads.length === 0 && (
					<div className="px-4 py-6 text-sm text-muted-foreground">
						No scratchpads yet. Use the composer above, or have an agent call{' '}
						<code className="font-mono">iyke_scratchpad_write</code>.
					</div>
				)}
				<ul>
					{list.data?.scratchpads.map((sp) => (
						<li
							key={sp.id}
							className="group flex items-start gap-3 border-b border-border/60 px-4 py-3 hover:bg-muted/40"
						>
							<button
								type="button"
								className="flex-1 text-left"
								onClick={() => openInPane(scope, sp.name)}
							>
								<div className="font-mono text-sm font-medium">{sp.name}</div>
								<div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
									{sp.preview || '(empty)'}
								</div>
								<div className="mt-1 text-[11px] text-muted-foreground/70 tabular-nums">
									updated {formatRelative(sp.updated_at)}
								</div>
							</button>
							<button
								type="button"
								className="opacity-0 transition group-hover:opacity-100"
								title="Delete scratchpad"
								onClick={() => {
									if (window.confirm(`Delete scratchpad "${sp.name}"?`)) {
										deleteMut.mutate(sp.name);
									}
								}}
							>
								<Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
							</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function formatRelative(unixMs: number): string {
	const diff = Date.now() - unixMs;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export const Route = createFileRoute('/scratchpads')({
	component: ScratchpadsPage,
});
