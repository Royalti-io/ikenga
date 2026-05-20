// ADR-013 §5 — shared per-engine auth component.
//
// One component, two mount surfaces:
//   1. The onboarding wizard's agent step (below the engine grid, for the
//      engine the user picked as default).
//   2. A lazy side-sheet opened from the chat-header engine picker when the
//      user clicks a not-installed engine row.
//
// It does two things per engine, both driven by `ENGINE_ONBOARDING`:
//   • Set API key(s) — written workspace-scoped to the Stronghold vault via
//     `secretsSetScoped`. Optional for engines whose canonical path is an
//     interactive login (Claude, Gemini); required for Codex.
//   • Run the interactive auth command (`gemini auth` / `codex login`) in a
//     transient side-pane terminal. We don't have a one-shot PTY executor,
//     so we spawn a normal terminal session, surface it in the focused pane,
//     and watch the terminal store for that session's `exited` status. On
//     exit we re-probe `agent_detect` so the picker / wizard reflect the new
//     auth state without a manual re-scan.

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { open as openExternal } from '@tauri-apps/plugin-shell';

import { Button } from '@/components/ui/button';
import { secretsGetScoped, secretsSetScoped } from '@/lib/tauri-cmd';
import { createTerminalSession } from '@/terminal/single-terminal';
import { useTerminalStore } from '@/terminal/session-store';
import { usePaneStore } from '@/lib/panes/pane-store';

import { engineOnboardingFor } from '../engines';

interface EngineAuthPanelProps {
	/** Chat-layer engine id (claude-code / gemini / codex / cursor-agent). */
	engineId: string;
	/** Display label for headings. Falls back to the engine id. */
	engineLabel?: string;
	/** Fired once the interactive auth command exits (success or not — we
	 *  can't tell from a PTY exit code alone, so callers should re-read the
	 *  detect state). Used by both mount surfaces to refresh their view. */
	onAuthComplete?: () => void;
}

export function EngineAuthPanel({ engineId, engineLabel, onAuthComplete }: EngineAuthPanelProps) {
	const meta = engineOnboardingFor(engineId);
	const label = engineLabel ?? engineId;
	const queryClient = useQueryClient();

	// Track the transient auth terminal session so we can watch it exit.
	const [authSessionId, setAuthSessionId] = useState<string | null>(null);
	const authSessionStatus = useTerminalStore((s) =>
		authSessionId ? (s.tabs.find((t) => t.id === authSessionId)?.status ?? null) : null
	);

	// When the auth terminal exits, re-probe detect + registered engines so
	// the wizard card / picker row flips to "signed in" without a manual
	// re-scan. We can't read the exit code's auth meaning, so we just
	// invalidate and let the probe decide.
	useEffect(() => {
		if (!authSessionId) return;
		if (authSessionStatus !== 'exited') return;
		void queryClient.invalidateQueries({ queryKey: ['detect-agents'] });
		void queryClient.invalidateQueries({ queryKey: ['chat-engines-list'] });
		onAuthComplete?.();
		setAuthSessionId(null);
	}, [authSessionId, authSessionStatus, queryClient, onAuthComplete]);

	if (!meta) {
		return (
			<div className="rounded-md border border-[var(--rule)] bg-[var(--rule-soft)] p-4 text-xs text-[var(--chip-carve)]">
				No auth setup is needed for {label}.
			</div>
		);
	}

	const authRunning = authSessionId !== null && authSessionStatus !== 'exited';

	function handleRunAuth() {
		if (!meta?.authCommand) return;
		// Spawn the auth command in a transient terminal and surface it in the
		// focused pane. We watch the session store for its exit above.
		const sessionId = createTerminalSession({
			cmd: meta.authCommand.split(' '),
			title: `${label} · auth`,
		});
		const focusedId = usePaneStore.getState().focusedId;
		usePaneStore.getState().addTab(focusedId, { kind: 'terminal', sessionId });
		setAuthSessionId(sessionId);
	}

	return (
		<div className="flex flex-col gap-4">
			{/* API key inputs (one per declared vault key). */}
			{meta.vaultKeys.map((key) => (
				<VaultKeyField key={key} vaultKey={key} optional={meta.vaultKeyOptional} />
			))}

			{/* Interactive auth — runs in a side-pane terminal. */}
			{meta.authCommand && (
				<div className="flex flex-col gap-2 rounded-md border border-[var(--rule)] bg-[var(--rule-soft)] p-3">
					<div className="text-[13px] font-semibold">Sign in to {label}</div>
					<div className="text-xs text-[var(--chip-carve)]">
						Runs <span className="font-mono text-[11.5px] text-foreground">{meta.authCommand}</span>{' '}
						in a terminal pane. Complete the prompts there; we'll re-check automatically when it
						exits.
					</div>
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={handleRunAuth} disabled={authRunning}>
							{authRunning ? 'Waiting for auth…' : 'Run auth'}
						</Button>
						{meta.docsUrl && (
							<button
								type="button"
								onClick={() => void openExternal(meta.docsUrl as string).catch(() => {})}
								className="text-xs text-[var(--kola-amber-soft)] underline-offset-2 hover:underline"
							>
								Docs →
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/** A single vault-key field. Shows a "saved" badge when the key is already
 *  set, a password input to set/replace it, and writes workspace-scoped. */
function VaultKeyField({ vaultKey, optional }: { vaultKey: string; optional: boolean }) {
	const [value, setValue] = useState('');
	const [saved, setSaved] = useState<boolean | null>(null); // null = unknown/loading
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const scope = useMemo(() => ({ kind: 'workspace' as const }), []);

	// Probe whether the key is already in the vault (don't surface the value).
	useEffect(() => {
		let cancelled = false;
		void secretsGetScoped(scope, vaultKey)
			.then((v) => {
				if (!cancelled) setSaved(v !== null && v !== '');
			})
			.catch(() => {
				if (!cancelled) setSaved(false);
			});
		return () => {
			cancelled = true;
		};
	}, [scope, vaultKey]);

	async function handleSave() {
		const trimmed = value.trim();
		if (!trimmed) {
			setError('Enter a value.');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await secretsSetScoped(scope, vaultKey, trimmed);
			setSaved(true);
			setValue('');
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-[var(--rule)] bg-[var(--rule-soft)] p-3">
			<div className="flex items-center gap-2">
				<span className="font-mono text-[11.5px] text-foreground">{vaultKey}</span>
				{optional && (
					<span className="text-[10px] uppercase text-[var(--chip-carve)]">optional</span>
				)}
				{saved && (
					<span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--kola-amber)]">
						saved
					</span>
				)}
			</div>
			<div className="flex gap-2">
				<input
					type="password"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={saved ? 'Replace stored key…' : 'Paste API key…'}
					className="flex-1 rounded-md border border-[var(--rule)] bg-background px-2 py-1 font-mono text-xs"
				/>
				<Button size="sm" variant="secondary" onClick={() => void handleSave()} disabled={busy}>
					{busy ? 'Saving…' : 'Save'}
				</Button>
			</div>
			{error && <div className="text-xs text-[var(--danger,#c00)]">{error}</div>}
		</div>
	);
}
