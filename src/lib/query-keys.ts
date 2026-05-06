/**
 * Central query key factory for TanStack Query.
 *
 * Convention: each domain returns a flat object of factories. Always include
 * the domain name as the first segment so cross-domain invalidations are easy
 * (e.g. `['email_drafts']` cascades to all sub-keys).
 *
 * Use these to keep query keys consistent and to avoid typos when invalidating
 * from mutations or realtime channels.
 */

import type { TxnFilters } from '@/lib/finance/transactions';
import type { EntityFilter } from '@/lib/finance/overview';

export const queryKeys = {
  inbox: {
    all: ['inbox'] as const,
    actionable: () => [...queryKeys.inbox.all, 'actionable'] as const,
    untriaged: () => [...queryKeys.inbox.all, 'untriaged'] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (filter: string) => [...queryKeys.tasks.all, 'list', filter] as const,
    detail: (id: string) => [...queryKeys.tasks.all, 'detail', id] as const,
    subtasks: (parentId: string) =>
      [...queryKeys.tasks.all, 'subtasks', parentId] as const,
  },
  delegations: {
    all: ['delegations'] as const,
    list: (filter: string) =>
      [...queryKeys.delegations.all, 'list', filter] as const,
    detail: (id: string) => [...queryKeys.delegations.all, 'detail', id] as const,
  },
  agentRuns: {
    all: ['agent_runs'] as const,
    list: (filter: string) =>
      [...queryKeys.agentRuns.all, 'list', filter] as const,
  },
  calendar: {
    all: ['calendar_events'] as const,
    week: (start: string, end: string) =>
      [...queryKeys.calendar.all, 'week', start, end] as const,
  },
  triage: {
    all: ['triage'] as const,
    next: () => [...queryKeys.triage.all, 'next'] as const,
  },
  mbox: {
    all: ['mbox'] as const,
    syncState: () => [...queryKeys.mbox.all, 'sync-state'] as const,
  },
  finance: {
    all: ['finance'] as const,
    overview: (entity: EntityFilter = 'all') =>
      ['finance', 'overview', entity] as const,
    transactions: (filters: TxnFilters) =>
      ['finance', 'transactions', filters] as const,
    transaction: (id: string) => ['finance', 'transaction', id] as const,
    accounts: () => ['finance', 'accounts'] as const,
    matrix: (asOf?: string) =>
      ['finance', 'ic-matrix', asOf ?? 'today'] as const,
    queue: (tab: string) => ['finance', 'ic-queue', tab] as const,
    runway: (entity: EntityFilter = 'all') =>
      ['finance', 'runway', entity] as const,
    pnl: (entity: EntityFilter, period: string, compare: string) =>
      ['finance', 'pnl', entity, period, compare] as const,
  },
  emailDrafts: {
    all: ['email_drafts'] as const,
    list: (status?: string) =>
      ['email_drafts', 'list', status ?? 'open'] as const,
    detail: (id: string) => ['email_drafts', 'detail', id] as const,
  },
  newsletterSends: {
    all: ['newsletter_sends'] as const,
    list: () => ['newsletter_sends', 'list'] as const,
  },
  newsletters: {
    all: ['newsletters'] as const,
    list: (status?: string) =>
      ['newsletters', 'list', status ?? 'pending'] as const,
    detail: (id: string) => ['newsletters', 'detail', id] as const,
  },
  socialQueue: {
    all: ['social_queue'] as const,
    list: (status?: string) =>
      ['social_queue', 'list', status ?? 'open'] as const,
    detail: (id: string) => ['social_queue', 'detail', id] as const,
  },
  sessions: {
    all: ['claude_sessions'] as const,
    list: (projectDir?: string | null) =>
      ['claude_sessions', 'list', projectDir ?? 'all'] as const,
    detail: (sessionId: string) =>
      ['claude_sessions', 'detail', sessionId] as const,
  },
  secrets: {
    all: ['secrets'] as const,
    vaultStatus: () => ['secrets', 'vault-status'] as const,
    keys: () => ['secrets', 'keys'] as const,
  },
  claudeConfig: {
    all: ['claude_config'] as const,
    load: (projectRoots: readonly string[]) =>
      ['claude_config', 'load', [...projectRoots].sort().join('|')] as const,
  },
} as const;
