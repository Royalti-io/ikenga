// /agent-runs — discoverability deep-link into com.ikenga.agent-ops "Runs" view.
//
// The agent-ops pkg is a top-level activity-bar app whose primary home is
// /pkg/com.ikenga.agent-ops/. The Runs view lives under that route tree.
// This shell-native route is a thin landing that navigates there and falls
// back to an informational page if the pkg is not yet installed.
//
// TODO (WP-08/WP-12): once the pkg registers its ui.routes with a stable
// sub-path (e.g. /pkg/com.ikenga.agent-ops/runs), upgrade this to a direct
// redirect so /agent-runs → the live Runs view with no intermediate UI.

import { createFileRoute } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { useEffect } from 'react';

import { usePaneStore } from '@/lib/panes/pane-store';
import { pkgKernelStatus } from '@/lib/tauri-cmd';

const AGENT_OPS_PKG_ID = 'com.ikenga.agent-ops';
// The pkg root path; WP-08 will replace this with a /runs sub-path.
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
				const installed = entries.some((e) => e.pkg_id === AGENT_OPS_PKG_ID);
				if (!cancelled && installed) {
					// Navigate to the pkg root; the pkg's own side-menu handles
					// switching to the Runs view. WP-08 will wire a direct sub-path
					// once the pkg declares it.
					navigateFocused(PKG_ROOT);
				}
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
