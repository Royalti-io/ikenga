// /projects/new-artifact — deep-link entry for the artifact creation wizard.
//
// Mounts the same `<ArtifactWizard />` component used by the command-palette
// entry and the ⌘⇧N global keybinding (D8 in
// plans/shell/2026-05-17-projects-and-artifact-wizard.md). Closing the
// wizard navigates back so the route doesn't dead-end on an empty page.
//
// Search params:
//   ?project=<id>        — pre-select project
//   ?archetype=<slug>    — pre-select archetype
//   ?folder=<abs path>   — override the watched folder

import { useState } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';

import { ArtifactWizard } from '@/shell/artifact-wizard/artifact-wizard';

interface NewArtifactSearch {
	project?: string;
	archetype?: string;
	folder?: string;
}

function NewArtifactRoute() {
	const search = useSearch({ from: '/projects/new-artifact' });
	const navigate = useNavigate();
	const [open, setOpen] = useState(true);
	return (
		<div className="flex h-full w-full items-center justify-center bg-muted/10 p-8 text-sm text-muted-foreground">
			<div>Opening the new-artifact wizard…</div>
			<ArtifactWizard
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					if (!v) {
						// Go home — the wizard's own success / cancel buttons fire
						// this on close. Keeping the user on `/projects/new-artifact`
						// after dismissal would just show the placeholder above.
						void navigate({ to: '/' });
					}
				}}
				prefill={{
					projectId: search.project ?? null,
					archetypeSlug: search.archetype ?? null,
					folder: search.folder ?? null,
				}}
			/>
		</div>
	);
}

export const Route = createFileRoute('/projects/new-artifact')({
	component: NewArtifactRoute,
	validateSearch: (s: Record<string, unknown>): NewArtifactSearch => ({
		project: typeof s.project === 'string' ? s.project : undefined,
		archetype: typeof s.archetype === 'string' ? s.archetype : undefined,
		folder: typeof s.folder === 'string' ? s.folder : undefined,
	}),
});
