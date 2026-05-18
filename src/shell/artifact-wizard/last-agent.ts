// Per-project "last used agent" memory for the wizard.
//
// Without this the wizard always pre-selects the onboarding default
// (`useShellStore.onboarding.selectedAgentId`). With it: pick codex once
// for project X and the next open in X pre-fills codex. Falls back to
// onboarding when no per-project pref exists.
//
// Keys live in `settings_kv`:
//   artifact-wizard.lastAgent.<projectId>        — 'claude' | 'codex' | 'gemini' | 'custom'
//   artifact-wizard.lastAgentCustom.<projectId>  — full argv string for the 'custom' kind

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';

import type { AgentChoice } from '@/shell/artifact-wizard/scaffold';

export type AgentKind = AgentChoice['kind'];

const KIND_KEY = (projectId: string) => `artifact-wizard.lastAgent.${projectId}`;
const CUSTOM_KEY = (projectId: string) => `artifact-wizard.lastAgentCustom.${projectId}`;

function isAgentKind(v: unknown): v is AgentKind {
	return v === 'claude' || v === 'codex' || v === 'gemini' || v === 'custom';
}

export async function loadLastAgent(projectId: string): Promise<AgentKind | null> {
	try {
		const raw = await settingsGet(KIND_KEY(projectId));
		if (isAgentKind(raw)) return raw;
	} catch {
		// settings_kv read failure — caller falls back to onboarding default.
	}
	return null;
}

export async function loadLastAgentCustom(projectId: string): Promise<string | null> {
	try {
		const raw = await settingsGet(CUSTOM_KEY(projectId));
		if (typeof raw === 'string' && raw.length > 0) return raw;
	} catch {}
	return null;
}

export async function saveLastAgent(projectId: string, kind: AgentKind): Promise<void> {
	await settingsSet(KIND_KEY(projectId), kind);
}

export async function saveLastAgentCustom(projectId: string, cmd: string): Promise<void> {
	const trimmed = cmd.trim();
	if (trimmed.length === 0) return;
	await settingsSet(CUSTOM_KEY(projectId), trimmed);
}
