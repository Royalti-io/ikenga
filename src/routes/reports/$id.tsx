import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Clock,
  AlertTriangle,
  AlertCircle,
  User,
  Tag,
  Timer,
  FileBarChart,
  Loader2,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/components/ui/utils';

interface AgentReport {
  id: string;
  job_id: string;
  title: string;
  report_type: string;
  domain: string;
  authored_by: string;
  summary: string | null;
  body: string | null;
  has_warnings: boolean;
  has_critical: boolean;
  duration_ms: number | null;
  created_at: string;
  alerts?: unknown[] | null;
  key_metrics?: Record<string, unknown> | null;
  session_id?: string | null;
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

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
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

function ReportDetailPage() {
  const { id } = Route.useParams();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['report', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_reports')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data as AgentReport;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Report not found.</p>
        <Link to="/reports" className="text-blue-600 hover:underline">
          Back to reports
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Link
        to="/reports"
        className="mb-4 inline-block text-sm text-blue-600 hover:underline"
      >
        &larr; Back to Reports
      </Link>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900">{report.title}</h1>
            {report.has_critical && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">
                <AlertCircle className="h-3 w-3" />
                Critical
              </span>
            )}
            {report.has_warnings && !report.has_critical && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                <AlertTriangle className="h-3 w-3" />
                Warnings
              </span>
            )}
          </div>
        </div>
        {report.summary && (
          <p className="text-sm text-gray-600">{report.summary}</p>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <User className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Agent</p>
              <p className="font-medium text-gray-900 text-sm">
                {report.authored_by}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <Tag className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Domain</p>
              <span
                className={cn(
                  'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                  getDomainColor(report.domain),
                )}
              >
                {report.domain}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <FileBarChart className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Type</p>
              <p className="font-medium text-gray-900 text-sm capitalize">
                {report.report_type}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <Timer className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Duration</p>
              <p className="font-medium text-gray-900 text-sm">
                {formatDuration(report.duration_ms)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Created</p>
              <p className="font-medium text-gray-900 text-sm">
                {formatDate(report.created_at)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {report.alerts && Array.isArray(report.alerts) && report.alerts.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {report.alerts.map((alert, idx) => (
                <li
                  key={idx}
                  className="text-sm text-gray-700 flex items-start gap-2"
                >
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                  {typeof alert === 'string'
                    ? alert
                    : JSON.stringify(alert)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {report.key_metrics && Object.keys(report.key_metrics).length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Key Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Object.entries(report.key_metrics).map(([key, value]) => (
                <div key={key} className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs text-gray-500 capitalize">
                    {key.replace(/_/g, ' ')}
                  </p>
                  <p className="text-lg font-semibold text-gray-900">
                    {String(value)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Full Report</CardTitle>
        </CardHeader>
        <CardContent>
          {report.body ? (
            // TODO(api): wire up Markdown renderer later — plain text for now.
            <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">
              {report.body}
            </pre>
          ) : (
            <p className="text-sm text-gray-500 italic">
              No report body available.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 text-xs text-gray-400">
        Job: {report.job_id} | ID: {report.id}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/reports/$id')({
  component: ReportDetailPage,
});
