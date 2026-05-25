import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { claudeConfigQueryOptions, useClaudeConfigWatch } from '@/lib/queries/claude-config';
import { useShellStore } from '@/lib/shell/shell-store';
import {
	NgwaSurface,
	type NgwaKindId,
	type NgwaScopeId,
	type NgwaSurfaceId,
} from '@/shell/claude-config/ngwa-surface';
import type { ClaudeStoreScope } from '@/lib/tauri-cmd';

import '@/shell/claude-config/claude-config.css';

// Ngwa deep-link params (threaded by ngwa-mode.tsx sidebar). All optional — a
// bare `/claude` is the Ngwa Browse landing (surface=browse, scope=all,
// kind=skills).
const ngwaSearchSchema = z.object({
	surface: z.enum(['browse', 'registry', 'graph', 'map', 'life', 'health', 'flow']).optional(),
	// 'all' | 'personal' | `project:<id>` (one per scanned project root).
	scope: z.string().optional(),
	kind: z.enum(['skills', 'agents', 'commands', 'hooks', 'mcps', 'store']).optional(),
});

export const Route = createFileRoute('/claude')({
	component: ClaudeLayout,
	validateSearch: ngwaSearchSchema,
});

function ClaudeLayout() {
	const projectRoots = useShellStore((s) => s.claudeProjectRoots);
	const watchEnabled = useShellStore((s) => s.claudeWatchEnabled);

	const query = useQuery(claudeConfigQueryOptions(projectRoots));
	useClaudeConfigWatch(projectRoots, watchEnabled);

	function handleOpenInEditor(path: string) {
		void shellOpen(path);
	}

	const path = useLocation({ select: (l) => l.pathname });
	const isNgwaIndex = path === '/claude';

	// Ngwa surface params. The bare `/claude` path is the Ngwa Manage surface
	// (Browse/Registry + write actions). Child paths (only `/claude/runtime-mcps`
	// survives) render bare into the Outlet.
	const search = Route.useSearch();
	const ngwaSurface: NgwaSurfaceId = search.surface ?? 'browse';
	const ngwaScope: NgwaScopeId = (search.scope as NgwaScopeId) ?? 'all';
	const ngwaKind: NgwaKindId = search.kind ?? 'skills';

	// Derive the move/copy/install destination scopes from the user's project
	// roots, mapping each root onto the store-scope grammar (`project:<id>`).
	const projectScopes = useMemo(
		() =>
			projectRoots.map((root) => {
				const id = root.split('/').filter(Boolean).pop() ?? 'project';
				return { key: `project:${id}` as ClaudeStoreScope, label: id };
			}),
		[projectRoots]
	);

	if (isNgwaIndex) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex-1 min-h-0">
					<NgwaSurface
						config={query.data ?? null}
						isLoading={query.isLoading}
						error={query.error ? String(query.error) : null}
						surface={ngwaSurface}
						scope={ngwaScope}
						kind={ngwaKind}
						onEdit={handleOpenInEditor}
						projectScopes={projectScopes}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<Outlet />
		</div>
	);
}
