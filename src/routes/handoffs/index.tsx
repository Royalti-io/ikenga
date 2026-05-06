import { useState, useEffect, useCallback } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2, ArrowRight, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface AgentHandoffDB {
  id: string;
  from_agent: string;
  to_agent: string;
  domain: string;
  request_type: string;
  request_summary: string;
  urgency: string;
  status: string;
  timestamp: string;
}

interface HandoffsResponse {
  data: AgentHandoffDB[];
  pagination?: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
}

function getAgentColor(agent: string): string {
  const normalized = agent.toLowerCase();
  if (normalized.includes('cmo') || normalized.includes('marketing'))
    return 'bg-purple-100 text-purple-800';
  if (normalized.includes('cfo') || normalized.includes('finance'))
    return 'bg-green-100 text-green-800';
  if (normalized.includes('cto') || normalized.includes('tech'))
    return 'bg-blue-100 text-blue-800';
  if (normalized.includes('clo') || normalized.includes('legal'))
    return 'bg-red-100 text-red-800';
  if (normalized.includes('pa') || normalized.includes('assistant'))
    return 'bg-orange-100 text-orange-800';
  if (normalized.includes('seo')) return 'bg-teal-100 text-teal-800';
  if (normalized.includes('content')) return 'bg-pink-100 text-pink-800';
  return 'bg-gray-100 text-gray-800';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'pending':
      return 'bg-yellow-100 text-yellow-800';
    case 'in_progress':
      return 'bg-blue-100 text-blue-800';
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return (
    date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' +
    date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function HandoffsPage() {
  const [data, setData] = useState<HandoffsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHandoffs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pageSize = 50;
      const { data: rows, count, error: dbErr } = await supabase
        .from('agent_handoffs')
        .select(
          'id, from_agent, to_agent, domain, request_type, request_summary, urgency, status, timestamp',
          { count: 'exact' },
        )
        .order('timestamp', { ascending: false })
        .range(0, pageSize - 1);
      if (dbErr) throw new Error(dbErr.message);
      const totalCount = count ?? 0;
      setData({
        data: (rows ?? []) as AgentHandoffDB[],
        pagination: {
          page: 1,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          hasMore: totalCount > pageSize,
        },
      });
    } catch (err) {
      console.error('Failed to fetch handoffs:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHandoffs();
  }, [fetchHandoffs]);

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Handoffs</h1>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">
              Failed to load handoffs
            </p>
            <p className="text-sm text-red-600">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => fetchHandoffs()}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">From / To</th>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Request Type</th>
                <th className="px-4 py-3">Summary</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {!data || data.data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No handoffs found.
                  </td>
                </tr>
              ) : (
                data.data.map((handoff) => (
                  <tr
                    key={handoff.id}
                    className="cursor-pointer hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to="/handoffs/$id"
                        params={{ id: handoff.id }}
                        className="flex items-center gap-2"
                      >
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${getAgentColor(handoff.from_agent)}`}
                        >
                          {handoff.from_agent}
                        </span>
                        <ArrowRight className="h-3 w-3 text-gray-400" />
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${getAgentColor(handoff.to_agent)}`}
                        >
                          {handoff.to_agent}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-800">
                        {handoff.domain}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {handoff.request_type}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <div className="flex items-center gap-2">
                        <span>{truncate(handoff.request_summary, 60)}</span>
                        {handoff.urgency === 'urgent' && (
                          <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                            Urgent
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(handoff.status)}`}
                      >
                        {handoff.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {formatTimestamp(handoff.timestamp)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/handoffs/')({
  component: HandoffsPage,
});
