import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle } from 'lucide-react';

import { supabase } from '@/lib/supabase';

interface JobState {
  consecutiveErrors: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  lastDurationMs?: number;
  totalCostUsd?: number;
  totalTokens?: number;
  totalRuns?: number;
  nextRunAtMs?: number;
}

interface CronJobConfig {
  id: string;
  agent: string;
  command: string;
  enabled: boolean;
  model?: string;
  timeoutMs?: number;
  schedule: { kind: string; expr?: string; at?: string; everyMs?: number };
  report?: { domain: string; type: string };
  state: JobState;
}

interface CronRun {
  id: string;
  job_id: string;
  agent: string;
  status: string;
  error: string | null;
  summary: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  num_turns: number | null;
  created_at: string;
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color ?? 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '-';
  return `$${usd.toFixed(2)}`;
}

type Tab = 'jobs' | 'runs';

function CronPage() {
  const [tab, setTab] = useState<Tab>('runs');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  // TODO(api): wire up jobs.json via Tauri command later.
  // jobs.json lives at <monorepo>/.company/cron/jobs.json — desktop has no SSR.
  const jobs: CronJobConfig[] = [];

  const { data: runs, isLoading, error } = useQuery({
    queryKey: ['cron', 'runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cron_job_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as CronRun[];
    },
  });

  const enabledJobs = jobs.filter((j) => j.enabled);
  const healthyJobs = enabledJobs.filter((j) => j.state.consecutiveErrors === 0);
  const erroringJobs = enabledJobs.filter((j) => j.state.consecutiveErrors > 0);
  const totalCost = enabledJobs.reduce(
    (sum, j) => sum + (j.state.totalCostUsd ?? 0),
    0,
  );
  const totalRuns = enabledJobs.reduce(
    (sum, j) => sum + (j.state.totalRuns ?? 0),
    0,
  );

  const agents = [...new Set((runs ?? []).map((r) => r.agent))].sort();
  const filteredRuns =
    agentFilter === 'all'
      ? runs ?? []
      : (runs ?? []).filter((r) => r.agent === agentFilter);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Cron Health</h1>
        <p className="mt-1 text-sm text-gray-500">
          Scheduler status, job costs, and run history
        </p>
      </div>

      {/* Notice: jobs.json not yet wired up */}
      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-amber-800">
          <p className="font-medium">Jobs config not yet wired up</p>
          <p className="text-xs opacity-80 mt-1">
            jobs.json lives on the host filesystem and will be exposed via a
            Tauri command in a later phase. Showing runs from Supabase only.
          </p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Total Jobs" value={enabledJobs.length} />
        <StatCard
          label="Healthy"
          value={healthyJobs.length}
          color="text-green-600"
        />
        <StatCard
          label="Erroring"
          value={erroringJobs.length}
          color={erroringJobs.length > 0 ? 'text-red-600' : 'text-gray-900'}
        />
        <StatCard label="Total Cost" value={formatCost(totalCost)} />
        <StatCard label="Total Runs" value={totalRuns} />
      </div>

      <div className="mb-4 flex items-center gap-4">
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
          {(['jobs', 'runs'] as Tab[]).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'jobs' ? 'Jobs' : 'Recent Runs'}
            </button>
          ))}
        </div>
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm"
        >
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      )}

      {error instanceof Error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load cron runs: {error.message}
        </div>
      )}

      {tab === 'jobs' && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white py-12 text-center text-sm text-gray-500">
          Jobs panel not yet wired up — see notice above.
        </div>
      )}

      {tab === 'runs' && !isLoading && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                  Job
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                  Agent
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                  Summary
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                  Duration
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                  Cost
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                  Time
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRuns.map((run) => (
                <tr
                  key={run.id}
                  className={`hover:bg-gray-50 ${
                    run.status === 'error' ? 'bg-red-50' : ''
                  }`}
                >
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {run.job_id}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {run.agent}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        run.status === 'ok'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-500">
                    {run.error ?? run.summary?.slice(0, 80) ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-500">
                    {formatDuration(run.duration_ms)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium text-gray-700">
                    {run.cost_usd != null
                      ? `$${Number(run.cost_usd).toFixed(4)}`
                      : '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-500">
                    {new Date(run.created_at).toLocaleString('en-GB', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRuns.length === 0 && (
            <div className="py-8 text-center text-sm text-gray-500">
              No runs recorded yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/cron/')({
  component: CronPage,
});
