// TanStack Query factories for the Phase 4 layered Claude config browser.
//
// These wrap `claudeAssetsDiscover` (4-tier discovery) and `claudeAssetListPins`
// from `lib/tauri-cmd.ts`. The legacy 2-tier scan continues to live in
// `queries/claude-config.ts` for the older /claude views.
//
// Query keys are namespaced under `['project-scoped', 'claude-assets', …]` to
// match the existing project-scoped invalidation pattern used elsewhere in the
// shell (see `routes/sessions/index.tsx`).

import { queryOptions } from '@tanstack/react-query';

import {
	claudeAssetListPins,
	claudeAssetsDiscover,
	type ClaudeAssetPin,
	type ClaudeAssetTree,
} from '@/lib/tauri-cmd';

export type { ClaudeAssetPin, ClaudeAssetTree };

export function claudeAssetsQueryOptions(projectId: string | null) {
	return queryOptions({
		queryKey: ['project-scoped', 'claude-assets', { projectId }] as const,
		queryFn: () => claudeAssetsDiscover(projectId),
		staleTime: 10_000,
	});
}

export function claudeAssetPinsQueryOptions(scope: string | null) {
	return queryOptions({
		queryKey: ['project-scoped', 'claude-asset-pins', { scope }] as const,
		queryFn: () => (scope ? claudeAssetListPins(scope) : Promise.resolve<ClaudeAssetPin[]>([])),
		enabled: !!scope,
		staleTime: 10_000,
	});
}
