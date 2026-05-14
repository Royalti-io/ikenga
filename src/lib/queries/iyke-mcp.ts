// TanStack Query factory for the runtime MCP view (Phase 5 deferred sub-UI).
//
// Wraps `/iyke/mcp/list`. Live-refreshed at 5s while the tab is mounted so
// supervisor state badges (Running/Parked/Crashed) don't go stale.

import { queryOptions } from '@tanstack/react-query';

import { listIykeMcps, type IykeMcpListResponse } from '@/lib/iyke/mcp';

export type { IykeMcpListResponse };

export function iykeMcpListQueryOptions(projectId: string | null) {
	return queryOptions({
		queryKey: ['project-scoped', 'iyke-mcp-list', { projectId }] as const,
		queryFn: () => listIykeMcps(projectId ?? undefined),
		enabled: !!projectId,
		staleTime: 2_000,
		refetchInterval: 5_000,
	});
}
