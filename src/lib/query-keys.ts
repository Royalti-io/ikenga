/**
 * Central query key factory for TanStack Query.
 *
 * Post-strip: only shell-internal queries live here. App pkgs (email, finance,
 * etc.) keep their own factories inside their own iframe bundles and namespace
 * via the QueriesRegistry's `queries.key_prefixes` declaration.
 *
 * Convention: each domain returns a flat object of factories. Always include
 * the domain name as the first segment so cross-domain invalidations are easy.
 */

export const queryKeys = {
	sessions: {
		all: ['claude_sessions'] as const,
		list: (projectDir?: string | null) => ['claude_sessions', 'list', projectDir ?? 'all'] as const,
		detail: (sessionId: string) => ['claude_sessions', 'detail', sessionId] as const,
	},
	secrets: {
		all: ['secrets'] as const,
		vaultStatus: () => ['secrets', 'vault-status'] as const,
		keys: () => ['secrets', 'keys'] as const,
	},
	fs: {
		all: ['fs'] as const,
		list: (path: string) => ['fs', 'list', path] as const,
		search: (root: string, query: string, showHidden: boolean, showIgnored: boolean) =>
			['fs', 'search', root, query, showHidden, showIgnored] as const,
	},
	claudeConfig: {
		all: ['claude_config'] as const,
		load: (projectRoots: readonly string[]) =>
			['claude_config', 'load', [...projectRoots].sort().join('|')] as const,
	},
} as const;
