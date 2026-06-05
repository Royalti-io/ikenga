// /agent-runs — deep-link into the com.ikenga.agent-ops "Runs" view.
//
// The agent-ops pkg is a top-level activity-bar app whose primary home is
// /pkg/com.ikenga.agent-ops/. The pkg registers /schedule /runs /failures
// /live as real sub-routes (all mounting the same bundle; the pkg derives its
// initial view from the pane's pathname), so this route deep-links directly.
// We also set the pkg-menu active feature so an ALREADY-MOUNTED agent-ops
// iframe swaps views via the hostContext re-emit (a same-source sub-route
// change doesn't remount the iframe, so the URL alone wouldn't reach it).
// Falls back to an informational landing if the pkg is not installed.

import { createFileRoute } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { useEffect } from 'react';

import { usePaneStore } from '@/lib/panes/pane-store';
import { usePkgMenuStore } from '@/lib/pkg/pkg-menu-store';
import { pkgKernelStatus } from '@/lib/tauri-cmd';

const AGENT_OPS_PKG_ID = 'com.ikenga.agent-ops';
const RUNS_PATH = `/pkg/${AGENT_OPS_PKG_ID}/runs`;
// Pre-sub-route installs only register `/` — fall back so the deep-link still
// lands on the pkg instead of bouncing off the catch-all.
const PKG_ROOT = `/pkg/${AGENT_OPS_PKG_ID}/`;

function AgentRunsPage() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	// Attempt to forward to the pkg route if the pkg is registered.
	// If it isn't installed yet, fall through to the landing page below.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await pkgKernelStatus();
				const reg = (status.registries.ui_routes ?? {}) as {
					entries?: Array<{ pkg_id: string; path: string }>;
				};
				const entries = reg.entries ?? [];
				const pkgRoutes = entries.filter((e) => e.pkg_id === AGENT_OPS_PKG_ID);
				if (cancelled || pkgRoutes.length === 0) return;
				const hasRuns = pkgRoutes.some((e) => e.path === '/runs');
				usePkgMenuStore.getState().setActiveFeature(AGENT_OPS_PKG_ID, 'v:runs');
				navigateFocused(hasRuns ? RUNS_PATH : PKG_ROOT);
			} catch {
				// pkg not installed or kernel unreachable — show landing below.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [navigateFocused]);

	return (
		<div className="flex h-full flex-col bg-background">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-center gap-2">
					<Activity className="h-5 w-5 text-muted-foreground" />
					<h1 className="text-lg font-semibold">Agent Runs — agent-ops</h1>
				</div>
				<p className="mt-1 text-sm text-muted-foreground">
					Runs view for the agent-ops pkg. Execution history and live run status live here.
				</p>
			</div>
			<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
				<Activity className="h-12 w-12 text-muted-foreground/40" />
				<div className="max-w-sm">
					<div className="text-base font-medium">agent-ops not installed</div>
					<p className="mt-1 text-sm text-muted-foreground">
						Install the <code className="font-mono text-xs">com.ikenga.agent-ops</code> pkg to
						view agent run history. Once installed, this route redirects automatically to the Runs
						view.
					</p>
				</div>
				<button
					type="button"
					className="mt-2 rounded-md border border-border bg-muted px-4 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
					onClick={() => navigateFocused('/packages')}
				>
					Browse packages
				</button>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/agent-runs')({
	component: AgentRunsPage,
});
