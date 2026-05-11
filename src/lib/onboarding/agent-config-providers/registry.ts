// Provider registry. Pkgs and future built-ins register here at import
// time. The wizard never asks for a provider by anything other than the
// `selectedAgentId` from onboarding state — keeping this lookup the only
// indirection.

import { claudeCodeProvider } from './claude-code';
import type { AgentConfigProvider, ProviderId } from './types';

const providers = new Map<ProviderId, AgentConfigProvider>();

export function registerProvider(p: AgentConfigProvider): void {
	providers.set(p.agentId, p);
}

export function getProvider(agentId: ProviderId | null | undefined): AgentConfigProvider | null {
	if (!agentId) return null;
	return providers.get(agentId) ?? null;
}

export function listProviders(): AgentConfigProvider[] {
	return [...providers.values()];
}

// Register built-ins. v1 ships claude-code only.
registerProvider(claudeCodeProvider);
