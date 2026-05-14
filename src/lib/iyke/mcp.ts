// Thin client for the iyke MCP-runtime endpoints (Phase 5 of
// projects-first-class). Surfaces the resolved 4-tier MCP set with live
// supervisor state, and pkg-keyed restart for long-lived children.

import { iykeFetch } from './client';

export type IykeMcpTier = 'personal' | 'workspace_pkg' | 'project' | 'project_pkg';
export type IykeMcpLifecycle = 'long-lived' | 'per-call' | 'on-demand';

export interface IykeMcpEntry {
	name: string;
	/** pkg id, "personal", or "project:<id>". */
	provider: string;
	tier: IykeMcpTier;
	/** "stdio" | "http" | "sse" | null when re-parse fails. */
	transport: string | null;
	lifecycle: IykeMcpLifecycle;
	/** Long-lived: Running | Parked | Crashed | Blocked | ShuttingDown | not-started.
	 *  Per-call / on-demand: same string as `lifecycle`. */
	state: string;
	path: string;
	last_error: string | null;
}

export interface IykeMcpListResponse {
	mcps: IykeMcpEntry[];
}

export async function listIykeMcps(projectId?: string): Promise<IykeMcpListResponse> {
	const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
	const res = await iykeFetch(`/iyke/mcp/list${qs}`);
	if (!res.ok) {
		throw new Error(`iyke /iyke/mcp/list ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as IykeMcpListResponse;
}

export async function restartIykeMcp(pkgId: string): Promise<void> {
	const res = await iykeFetch('/iyke/mcp/restart', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ pkg_id: pkgId }),
	});
	if (!res.ok) {
		throw new Error(`iyke /iyke/mcp/restart ${res.status}: ${await res.text()}`);
	}
}
