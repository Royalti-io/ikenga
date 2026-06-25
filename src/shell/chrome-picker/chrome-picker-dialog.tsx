// Attach-Chrome picker — choose what the chrome browser engine drives.
//
// Decision tree (plans/playwright-adoption/11-profiles-attach.md):
//   • A debug CDP endpoint is reachable → list its live tabs. Pick a tab to
//     adopt it (attach_target=<targetId>), or "New tab" to open a fresh page
//     (attach_target=new) without disturbing the user's tabs.
//   • No endpoint → list on-disk OS Chrome profiles. Running ones are disabled
//     (singleton lock blocks launching them); picking an idle one launches it
//     with --remote-debugging-port, then re-probes targets.
//
// This is a control surface only: it asks the shell bridge to open a chrome
// attach pane. The pane's actual page-driving (snapshot/click/…) is owned by
// the pkg-browser MCP server.

import { Globe, Loader2, MonitorSmartphone, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandList } from '@/components/ui/command';
import { CommandRow } from '@/components/ui/command-row';
import {
	type BrowserProfile,
	browserLaunchProfile,
	browserOpen,
	browserProfiles,
	type BrowserTarget,
	browserTargets,
} from '@/lib/iyke/browser';

/** The pkg the attach pane is attributed to (the pkg-browser MCP server owns
 *  the page-driving verbs once attached). */
const BROWSER_PKG_ID = 'com.ikenga.mcp-browser';

interface ChromePickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type LoadState =
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| {
			phase: 'ready';
			endpoint: string | null;
			targets: BrowserTarget[];
			profiles: BrowserProfile[];
	  };

function newPaneId(): string {
	return `attach-${Date.now().toString(36)}`;
}

export function ChromePickerDialog({ open, onOpenChange }: ChromePickerDialogProps) {
	const [state, setState] = useState<LoadState>({ phase: 'loading' });
	// Tracks a profile launch in flight so the row can show a spinner + the rest
	// of the list disables.
	const [launchingDir, setLaunchingDir] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setState({ phase: 'loading' });
		setActionError(null);
		try {
			// targets first (cheap CDP probe); profiles only matter when no
			// endpoint is live, but fetch both so the panel can render in one pass.
			const [targetsRes, profilesRes] = await Promise.all([
				browserTargets(),
				browserProfiles().catch(() => ({ profiles: [] as BrowserProfile[] })),
			]);
			setState({
				phase: 'ready',
				endpoint: targetsRes.endpoint,
				targets: targetsRes.targets,
				profiles: profilesRes.profiles,
			});
		} catch (e) {
			setState({ phase: 'error', message: String(e instanceof Error ? e.message : e) });
		}
	}, []);

	// (Re)load every time the dialog opens; reset transient state on close.
	useEffect(() => {
		if (open) {
			void load();
		} else {
			setLaunchingDir(null);
			setActionError(null);
		}
	}, [open, load]);

	async function openAttach(attach_target: string, url?: string) {
		setActionError(null);
		try {
			await browserOpen({
				pkg_id: BROWSER_PKG_ID,
				pane_id: newPaneId(),
				url: url ?? 'about:blank',
				engine: 'chrome',
				mode: 'attach',
				attach_target,
			});
			onOpenChange(false);
		} catch (e) {
			setActionError(`Could not attach: ${String(e instanceof Error ? e.message : e)}`);
		}
	}

	async function launch(profile: BrowserProfile) {
		setLaunchingDir(profile.dir);
		setActionError(null);
		try {
			await browserLaunchProfile(profile.dir);
			// Chrome now exposes a debug port — re-probe so the live tabs surface.
			await load();
		} catch (e) {
			setActionError(
				`Could not launch ${profile.name}: ${String(e instanceof Error ? e.message : e)}`
			);
		} finally {
			setLaunchingDir(null);
		}
	}

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Attach Chrome profile or tab"
			description="Choose a live tab to drive, open a new tab, or launch a profile in debug mode."
		>
			<CommandInputHeader />
			<CommandList>
				{state.phase === 'loading' && (
					<div
						role="status"
						className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground"
					>
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						Probing Chrome…
					</div>
				)}

				{state.phase === 'error' && (
					<div role="alert" className="px-3 py-6 text-sm text-destructive">
						{state.message}
					</div>
				)}

				{state.phase === 'ready' && state.endpoint !== null && (
					<>
						<CommandEmpty>No live tabs.</CommandEmpty>
						<CommandGroup heading="Live tabs">
							<CommandRow
								size="sm"
								Icon={Plus}
								label="New tab"
								detail="open without disturbing existing tabs"
								onSelect={() => void openAttach('new')}
							/>
							{state.targets.map((t) => (
								<CommandRow
									key={t.targetId}
									size="sm"
									value={`${t.title} ${t.url} ${t.targetId}`}
									Icon={Globe}
									label={t.title || t.url || t.targetId}
									detail={t.url}
									onSelect={() => void openAttach(t.targetId)}
								/>
							))}
						</CommandGroup>
					</>
				)}

				{state.phase === 'ready' && state.endpoint === null && (
					<>
						<div className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
							No debug Chrome is running. Pick a profile to launch it with{' '}
							<span className="font-mono text-foreground">--remote-debugging-port</span>, or start
							Chrome yourself with that flag.
						</div>
						<CommandEmpty>No Chrome profiles found.</CommandEmpty>
						<CommandGroup heading="Chrome profiles">
							{state.profiles.map((p) => {
								const isLaunching = launchingDir === p.dir;
								return (
									<CommandRow
										key={p.dir}
										size="sm"
										value={`${p.name} ${p.dir}`}
										leading={
											isLaunching ? (
												<Loader2
													className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
													aria-hidden="true"
												/>
											) : (
												<MonitorSmartphone
													className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
													aria-hidden="true"
												/>
											)
										}
										label={p.name}
										detail={p.running ? `${p.dir} · already running` : p.dir}
										disabled={p.running || launchingDir !== null}
										onSelect={() => void launch(p)}
									/>
								);
							})}
						</CommandGroup>
					</>
				)}

				{actionError && (
					<div role="alert" className="px-3 py-3 text-xs text-destructive">
						{actionError}
					</div>
				)}
			</CommandList>
		</CommandDialog>
	);
}

// The picker is selection-only (short lists); a search input would add little.
// Render a static, non-interactive header row instead of CommandInput so cmdk
// doesn't filter away the "New tab" / launch affordances.
function CommandInputHeader() {
	return <div className="border-b border-border px-4 py-3 font-medium text-sm">Attach Chrome</div>;
}
