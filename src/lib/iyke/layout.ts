// Client for the /iyke/layout/* bridge endpoints (Phase 6).
// Lets the Settings UI (and MCP server) introspect or wipe a project's
// saved layout without touching SQLite directly.

import { iykeFetch } from './client';

export interface IykeLayoutResponse {
	project_id: string;
	pane_tree: unknown | null;
	files_explorer: unknown | null;
	panel_sizes: unknown | null;
}

export async function iykeLayoutGet(projectId?: string): Promise<IykeLayoutResponse> {
	const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
	const res = await iykeFetch(`/iyke/layout/get${qs}`);
	if (!res.ok) {
		throw new Error(`iyke /iyke/layout/get ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as IykeLayoutResponse;
}

export interface IykeLayoutResetResponse {
	ok: boolean;
	project_id: string;
	deleted_rows: number;
}

export async function iykeLayoutReset(projectId: string): Promise<IykeLayoutResetResponse> {
	const res = await iykeFetch('/iyke/layout/reset', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId }),
	});
	if (!res.ok) {
		throw new Error(`iyke /iyke/layout/reset ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as IykeLayoutResetResponse;
}
