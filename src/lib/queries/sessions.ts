import { queryOptions } from '@tanstack/react-query';

import {
	chatThreadsListByProject,
	claudeListSessions,
	claudeReadJsonl,
	type ChatEvent,
	type ChatThreadSummary,
	type SessionSummary,
} from '@/lib/tauri-cmd';
import { queryKeys } from '@/lib/query-keys';

/**
 * TanStack Query factories for Claude Code sessions.
 *
 * The list view scans `~/.claude/projects/**` (all slugs by default; pass
 * `projectDir` to restrict). Detail reads the on-disk jsonl into ChatEvents.
 * Live sessions are subscribed to separately via `claudeListenSession` —
 * they don't go through Query (the cache would fight the streaming nature).
 */

export type { ChatEvent, SessionSummary };

export function sessionsListQueryOptions(projectDir?: string | null, limit?: number | null) {
	return queryOptions({
		queryKey: [...queryKeys.sessions.list(projectDir), limit ?? 'all'] as const,
		queryFn: () => claudeListSessions(projectDir ?? null, limit ?? null),
		staleTime: 30_000,
	});
}

/**
 * Phase 3 (projects-first-class): list `chat_threads` rows scoped by the
 * active project. Distinct from `sessionsListQueryOptions` which scans
 * `~/.claude/projects/<slug>/*.jsonl` on disk — that view is the legacy
 * surface for "all sessions Claude has ever seen on this machine"; the
 * thread view is the canonical "what threads belong to this project".
 *
 * Key prefix `project-scoped` so a `projects.active-changed` listener
 * can invalidate every project-scoped query in one shot.
 */
export function chatThreadsByProjectQueryOptions(
	projectId: string | null,
	includeAll = false,
	limit?: number | null
) {
	return queryOptions({
		queryKey: [
			'project-scoped',
			'chat-threads',
			{ projectId, includeAll, limit: limit ?? null },
		] as const,
		queryFn: () => chatThreadsListByProject(projectId, includeAll, limit),
		staleTime: 10_000,
	});
}

export type { ChatThreadSummary };

export function sessionDetailQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: queryKeys.sessions.detail(sessionId),
		queryFn: () => claudeReadJsonl(sessionId),
		staleTime: Infinity,
		enabled: sessionId.length > 0,
	});
}

// ─── Agent grouping ───────────────────────────────────────────────────────────
//
// The `/sessions/$agent` view groups by the agent slug used in /agent-task-check
// commands and the agent-runs table. We extract the slug heuristically from
// the session title (most agent-driven sessions start with `/<slug>` or
// `/agent-task-check <slug>`). This matches PA's existing agent-centric view
// without requiring the chat thread to declare its agent up front.

const AGENT_SLUGS = [
	'pa-assistant',
	'cmo-agent',
	'cfo-agent',
	'cpo-agent',
	'cto-agent',
	'cbo-agent',
	'ceo-agent',
	'vp-sales-agent',
	'customer-success',
	'newsletter-agent',
	'fundraising-agent',
	'blog-writer',
	'competitor-analyst',
	'content-strategist',
	'content-refiner',
	'market-researcher',
	'prospect-researcher',
	'video-creator-agent',
	'analytics-coordinator',
	'product-expert',
	'system-architect',
	'support-insights',
	'seo-optimizer',
	'financial-analyst',
	'memory-recall',
	'clo-agent',
	'pa',
] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

export function detectAgentSlug(s: SessionSummary): AgentSlug | null {
	const title = (s.title ?? '').toLowerCase();
	// Look for an /agent-task-check <slug> framing first.
	const match = title.match(/agent-task-check\s+([a-z0-9-]+)/);
	if (match) {
		const slug = match[1];
		if ((AGENT_SLUGS as readonly string[]).includes(slug)) return slug as AgentSlug;
	}
	// Fall back to any agent slug appearing in the first line.
	for (const slug of AGENT_SLUGS) {
		if (title.includes(slug)) return slug;
	}
	return null;
}

export function groupByAgent(
	sessions: SessionSummary[]
): Map<AgentSlug | 'unassigned', SessionSummary[]> {
	const groups = new Map<AgentSlug | 'unassigned', SessionSummary[]>();
	for (const s of sessions) {
		const key = detectAgentSlug(s) ?? 'unassigned';
		const list = groups.get(key) ?? [];
		list.push(s);
		groups.set(key, list);
	}
	return groups;
}
