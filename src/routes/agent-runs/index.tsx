import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertCircle, Loader2 } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import {
  agentRunsListQuery,
  agentNamesQuery,
  type AgentRun,
} from '@/lib/queries/agent-runs';
import { PaActionsRefreshButton } from '@/components/pa-actions-refresh-button';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const TRIGGER_OPTIONS = [
  { value: '', label: 'All triggers' },
  { value: 'cron', label: 'Cron' },
  { value: 'manual', label: 'Manual' },
  { value: 'webhook', label: 'Webhook' },
];

function statusColor(s: string): string {
  switch (s) {
    case 'running':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'failed':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function RunRow({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className={cn(
          'border-t border-border hover:bg-accent/50',
          run.status === 'failed' && 'bg-red-50/40 dark:bg-red-950/10',
        )}
      >
        <td className="px-3 py-2 align-top font-medium">{run.agent_name}</td>
        <td className="px-3 py-2 align-top text-muted-foreground">
          <div className="max-w-[16rem] truncate" title={run.command ?? '—'}>
            {run.command ?? '—'}
          </div>
        </td>
        <td className="px-3 py-2 align-top">
          <Badge
            variant="outline"
            className={cn(
              'border text-[10px] uppercase',
              statusColor(run.status),
            )}
          >
            {run.status}
          </Badge>
        </td>
        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
          {run.triggered_by}
        </td>
        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
          {new Date(run.started_at).toLocaleString()}
        </td>
        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
          {formatDuration(run.started_at, run.completed_at)}
        </td>
        <td className="px-3 py-2 align-top text-right">
          {(run.output_summary || run.error_message) && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-primary hover:underline"
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          )}
        </td>
      </tr>
      {expanded && (run.output_summary || run.error_message) && (
        <tr className="border-t border-border">
          <td colSpan={7} className="bg-muted/30 px-3 py-3">
            {run.output_summary && (
              <pre className="whitespace-pre-wrap text-xs text-foreground">
                {run.output_summary}
              </pre>
            )}
            {run.error_message && (
              <pre className="mt-2 whitespace-pre-wrap text-xs text-destructive">
                Error: {run.error_message}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AgentRunsPage() {
  const [status, setStatus] = useState('');
  const [agentName, setAgentName] = useState('');
  const [triggeredBy, setTriggeredBy] = useState('');

  const { data: runs, isLoading, error } = useQuery(
    agentRunsListQuery({ status, agentName, triggeredBy }),
  );
  const { data: agentNames } = useQuery(agentNamesQuery());

  const stats = {
    running: runs?.filter((r) => r.status === 'running').length ?? 0,
    failed: runs?.filter((r) => r.status === 'failed').length ?? 0,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Agent runs</h1>
          {runs && (
            <span className="text-sm text-muted-foreground">
              ({runs.length})
            </span>
          )}
          <div className="ml-auto">
            <PaActionsRefreshButton
              subcommand="twenty-poll"
              label="Sync Twenty CRM"
              invalidateKeys={[['agent_runs']]}
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Recent agent executions across cron, manual, and webhook triggers.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <Tabs defaultValue="runs" className="w-full">
          <TabsList>
            <TabsTrigger value="runs" className="gap-2">
              All runs
              {stats.running > 0 && (
                <Badge
                  variant="outline"
                  className="border-blue-200 bg-blue-100 text-blue-800"
                >
                  {stats.running}
                </Badge>
              )}
              {stats.failed > 0 && (
                <Badge
                  variant="outline"
                  className="border-red-200 bg-red-100 text-red-800"
                >
                  {stats.failed} failed
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="runs" className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Agent
                <select
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  <option value="">All agents</option>
                  {agentNames?.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Trigger
                <select
                  value={triggeredBy}
                  onChange={(e) => setTriggeredBy(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  {TRIGGER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            )}

            {error instanceof Error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Failed to load runs</p>
                  <p className="text-xs opacity-80">{error.message}</p>
                </div>
              </div>
            )}

            {runs && runs.length === 0 && !isLoading && (
              <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                No agent runs match.
              </div>
            )}

            {runs && runs.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Agent</th>
                      <th className="px-3 py-2 text-left font-medium">Command</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Trigger</th>
                      <th className="px-3 py-2 text-left font-medium">Started</th>
                      <th className="px-3 py-2 text-left font-medium">Duration</th>
                      <th className="w-16 px-3 py-2 text-right font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <RunRow key={run.id} run={run} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/agent-runs/')({
  component: AgentRunsPage,
});
