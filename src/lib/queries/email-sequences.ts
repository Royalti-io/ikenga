import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// email_sequences (migration 029) status enum: draft|review|approved|active|paused|completed
export type EmailSequenceStatus =
  | 'draft'
  | 'review'
  | 'approved'
  | 'active'
  | 'paused'
  | 'completed';

export interface EmailSequence {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  total_steps: number;
  step_delays: number[];
  segment: string | null;
  delivery_system: 'listmonk' | 'resend' | 'smtp';
  status: EmailSequenceStatus;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

// Step body lives on email_drafts (sequence_id + sequence_step). There is
// no email_sequence_steps table — earlier code referenced a phantom one.
export interface SequenceStepDraft {
  id: string;
  sequence_id: string;
  sequence_step: number;
  subject: string;
  body: string;
  status: string;
  delivery_system: string;
  created_at: string;
}

export function emailSequencesListQuery(opts?: {
  statuses?: EmailSequenceStatus[];
}) {
  const statuses = opts?.statuses ?? ['draft', 'review', 'approved', 'active', 'paused'];
  return queryOptions({
    queryKey: ['email_sequences', 'list', statuses.join(',')] as const,
    queryFn: async (): Promise<EmailSequence[]> => {
      const { data, error } = await supabase
        .from('email_sequences')
        .select('*')
        .in('status', statuses)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as EmailSequence[];
    },
  });
}

export function sequenceStepsQuery(sequenceId: string | null) {
  return queryOptions({
    queryKey: ['email_sequences', 'steps', sequenceId] as const,
    enabled: !!sequenceId,
    queryFn: async (): Promise<SequenceStepDraft[]> => {
      if (!sequenceId) return [];
      const { data, error } = await supabase
        .from('email_drafts')
        .select(
          'id, sequence_id, sequence_step, subject, body, status, delivery_system, created_at',
        )
        .eq('sequence_id', sequenceId)
        .not('sequence_step', 'is', null)
        .order('sequence_step', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SequenceStepDraft[];
    },
  });
}
