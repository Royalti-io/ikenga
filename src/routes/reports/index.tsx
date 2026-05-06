import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';

interface AgentReport {
  id: string;
  job_id: string;
  title: string;
  report_type: string;
  domain: string;
  authored_by: string;
  summary: string | null;
  has_warnings: boolean;
  has_critical: boolean;
  duration_ms: number | null;
  created_at: string;
}

function getDomainColor(domain: string): string {
  switch (domain) {
    case 'finance':
      return 'bg-green-100 text-green-800';
    case 'sales':
      return 'bg-blue-100 text-blue-800';
    case 'product':
      return 'bg-indigo-100 text-indigo-800';
    case 'strategy':
      return 'bg-purple-100 text-purple-800';
    case 'fundraising':
      return 'bg-amber-100 text-amber-800';
    case 'content':
      return 'bg-pink-100 text-pink-800';
    case 'partnerships':
      return 'bg-teal-100 text-teal-800';
    case 'engineering':
      return 'bg-cyan-100 text-cyan-800';
    case 'ops':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function ReportsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'published'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_reports')
        .select(
          'id, job_id, title, report_type, domain, authored_by, summary, has_warnings, has_critical, duration_ms, created_at',
        )
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as AgentReport[];
    },
  });

  const reports = data ?? [];
  const domains = [...new Set(reports.map((r) => r.domain))].sort();

  const grouped = new Map<string, AgentReport[]>();
  for (const report of reports) {
    const date = new Date(report.created_at).toISOString().slice(0, 10);
    const existing = grouped.get(date) ?? [];
    existing.push(report);
    grouped.set(date, existing);
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Agent Reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Full reports from autonomous agent runs — status checks, analyses,
          reviews, and briefings
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      )}

      {error instanceof Error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load reports: {error.message}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase">
                Total Reports
              </p>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                {reports.length}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase">
                With Warnings
              </p>
              <p className="mt-1 text-2xl font-bold text-amber-600">
                {reports.filter((r) => r.has_warnings).length}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase">
                Critical
              </p>
              <p className="mt-1 text-2xl font-bold text-red-600">
                {reports.filter((r) => r.has_critical).length}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase">
                Domains
              </p>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                {domains.length}
              </p>
            </div>
          </div>

          {reports.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
              <p className="text-gray-500">
                No reports yet. Reports will appear here as agent cron jobs
                run.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {[...grouped.entries()].map(([date, dateReports]) => (
                <div key={date}>
                  <h2 className="mb-3 text-sm font-semibold text-gray-500 uppercase tracking-wider">
                    {new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </h2>
                  <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                    {dateReports.map((report, idx) => (
                      <Link
                        key={report.id}
                        to="/reports/$id"
                        params={{ id: report.id }}
                        className={cn(
                          'flex items-start gap-4 p-4 transition-colors hover:bg-gray-50',
                          idx > 0 && 'border-t border-gray-100',
                        )}
                      >
                        <div className="mt-1 flex shrink-0 flex-col items-center gap-1">
                          {report.has_critical ? (
                            <span
                              className="h-3 w-3 rounded-full bg-red-500"
                              title="Critical"
                            />
                          ) : report.has_warnings ? (
                            <span
                              className="h-3 w-3 rounded-full bg-amber-400"
                              title="Warnings"
                            />
                          ) : (
                            <span className="h-3 w-3 rounded-full bg-green-400" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-gray-900 truncate">
                              {report.title}
                            </h3>
                          </div>
                          {report.summary && (
                            <p className="mt-1 text-xs text-gray-500 line-clamp-2">
                              {report.summary.slice(0, 200)}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                                getDomainColor(report.domain),
                              )}
                            >
                              {report.domain}
                            </span>
                            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                              {getTypeLabel(report.report_type)}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-400">
                            <span>{report.authored_by}</span>
                            <span>{formatDuration(report.duration_ms)}</span>
                            <span>{formatDate(report.created_at)}</span>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/reports/')({
  component: ReportsPage,
});
