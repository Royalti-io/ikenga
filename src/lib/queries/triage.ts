import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export type TriageCategory =
  | 'urgent'
  | 'action_needed'
  | 'informational'
  | 'fyi';

export interface TriageMessage {
  id: string;
  subject: string | null;
  from_address: string;
  body_text: string | null;
  body_html: string | null;
  triage_category: string | null;
  triage_reason: string | null;
  received_at: string;
}

const TRIAGE_COLUMNS =
  'id, subject, from_address, body_text, body_html, triage_category, triage_reason, received_at';

/**
 * Pull the next untriaged message (single-message-at-a-time queue).
 * Untriaged = triage_category IS NULL.
 */
export function nextTriageMessageQuery() {
  return {
    queryKey: queryKeys.triage.next(),
    queryFn: async (): Promise<{
      message: TriageMessage | null;
      remaining: number;
    }> => {
      const { data, error } = await supabase
        .from('email_messages')
        .select(TRIAGE_COLUMNS)
        .is('triage_category', null)
        .order('received_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      const rows = (data ?? []) as TriageMessage[];
      return {
        message: rows[0] ?? null,
        remaining: rows.length,
      };
    },
    staleTime: 0,
  };
}
