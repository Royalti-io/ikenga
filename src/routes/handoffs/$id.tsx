import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Calendar,
  Clock,
  Mail,
  CheckSquare,
  FileText,
  AlertCircle,
  Target,
  Loader2,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/components/ui/utils';

interface AgentHandoffDB {
  id: string;
  from_agent: string;
  to_agent: string;
  domain: string;
  request_type: string;
  request_summary: string;
  result_summary?: string | null;
  urgency: string;
  status: string;
  expected_completion?: string | null;
  completion_time?: string | null;
  created_at: string;
  updated_at: string;
  context_email_ids?: string[] | null;
  context_task_ids?: string[] | null;
  context_files?: string[] | null;
}

function getAgentColor(agent: string): string {
  const a = agent.toLowerCase();
  if (a.includes('cmo') || a.includes('marketing'))
    return 'bg-purple-100 text-purple-800';
  if (a.includes('cfo') || a.includes('finance'))
    return 'bg-green-100 text-green-800';
  if (a.includes('cto') || a.includes('tech'))
    return 'bg-blue-100 text-blue-800';
  if (a.includes('clo') || a.includes('legal')) return 'bg-red-100 text-red-800';
  if (a.includes('pa') || a.includes('assistant'))
    return 'bg-orange-100 text-orange-800';
  if (a.includes('seo')) return 'bg-teal-100 text-teal-800';
  if (a.includes('content')) return 'bg-pink-100 text-pink-800';
  return 'bg-gray-100 text-gray-800';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'in_progress':
      return 'bg-blue-100 text-blue-800';
    case 'pending':
      return 'bg-yellow-100 text-yellow-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

function HandoffDetailPage() {
  const { id } = Route.useParams();

  const { data: handoff, isLoading, error } = useQuery({
    queryKey: ['handoff', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_handoffs')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data as AgentHandoffDB;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !handoff) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Handoff not found.</p>
        <Link to="/handoffs" className="text-blue-600 hover:underline">
          Back to handoffs
        </Link>
      </div>
    );
  }

  const hasContext =
    (handoff.context_email_ids && handoff.context_email_ids.length > 0) ||
    (handoff.context_task_ids && handoff.context_task_ids.length > 0) ||
    (handoff.context_files && handoff.context_files.length > 0);

  return (
    <div className="p-6">
      <Link
        to="/handoffs"
        className="mb-4 inline-block text-sm text-blue-600 hover:underline"
      >
        &larr; Back to Handoffs
      </Link>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-3 py-1 text-sm font-medium',
              getAgentColor(handoff.from_agent),
            )}
          >
            {handoff.from_agent}
          </span>
          <ArrowRight className="h-5 w-5 text-gray-400" />
          <span
            className={cn(
              'inline-flex items-center rounded-full px-3 py-1 text-sm font-medium',
              getAgentColor(handoff.to_agent),
            )}
          >
            {handoff.to_agent}
          </span>
          <span
            className={cn(
              'ml-auto inline-flex items-center rounded-full px-3 py-1 text-sm font-medium',
              getStatusColor(handoff.status),
            )}
          >
            {handoff.status.replace('_', ' ')}
          </span>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <Target className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Domain</p>
              <p className="font-medium text-gray-900 capitalize">
                {handoff.domain}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Request Type</p>
              <p className="font-medium text-gray-900 capitalize">
                {handoff.request_type}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <AlertCircle
              className={cn(
                'h-5 w-5',
                handoff.urgency === 'urgent' ? 'text-red-500' : 'text-gray-500',
              )}
            />
            <div>
              <p className="text-xs text-gray-500">Urgency</p>
              <p
                className={cn(
                  'font-medium capitalize',
                  handoff.urgency === 'urgent'
                    ? 'text-red-600'
                    : 'text-gray-900',
                )}
              >
                {handoff.urgency}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-gray-500" />
            <div>
              <p className="text-xs text-gray-500">Expected Completion</p>
              <p className="font-medium text-gray-900">
                {handoff.expected_completion
                  ? formatDate(handoff.expected_completion)
                  : 'Not set'}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Request Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-gray-700">
            {handoff.request_summary}
          </p>
        </CardContent>
      </Card>

      {handoff.result_summary && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Result Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-gray-700">
              {handoff.result_summary}
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Timestamps</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-400" />
              <div>
                <p className="text-xs text-gray-500">Created</p>
                <p className="text-sm text-gray-900">
                  {formatDate(handoff.created_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-400" />
              <div>
                <p className="text-xs text-gray-500">Completed</p>
                <p className="text-sm text-gray-900">
                  {handoff.completion_time
                    ? formatDate(handoff.completion_time)
                    : 'Not completed'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-400" />
              <div>
                <p className="text-xs text-gray-500">Updated</p>
                <p className="text-sm text-gray-900">
                  {formatDate(handoff.updated_at)}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {hasContext && (
        <Card>
          <CardHeader>
            <CardTitle>Context</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {handoff.context_email_ids &&
              handoff.context_email_ids.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <Mail className="h-4 w-4 text-gray-400" />
                    <p className="text-sm font-medium text-gray-700">
                      Linked Emails
                    </p>
                  </div>
                  <ul className="ml-6 space-y-1">
                    {handoff.context_email_ids.map((emailId) => (
                      <li key={emailId} className="text-sm text-gray-600">
                        {emailId}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            {handoff.context_task_ids &&
              handoff.context_task_ids.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-gray-400" />
                    <p className="text-sm font-medium text-gray-700">
                      Linked Tasks
                    </p>
                  </div>
                  <ul className="ml-6 space-y-1">
                    {handoff.context_task_ids.map((taskId) => (
                      <li key={taskId} className="text-sm text-gray-600">
                        {taskId}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            {handoff.context_files && handoff.context_files.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-gray-400" />
                  <p className="text-sm font-medium text-gray-700">
                    Context Files
                  </p>
                </div>
                <ul className="ml-6 space-y-1">
                  {handoff.context_files.map((file, index) => (
                    <li key={index} className="text-sm text-gray-600">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export const Route = createFileRoute('/handoffs/$id')({
  component: HandoffDetailPage,
});
