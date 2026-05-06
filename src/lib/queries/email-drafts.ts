import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export type EmailDraftStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed';

export type EmailDraftType = 'outreach' | 'newsletter' | 'investor_update';

export interface EmailRecipient {
  email: string;
  name?: string;
  first_name?: string;
  tier?: string;
  [key: string]: unknown;
}

export interface EmailDraftSequence {
  name: string;
  slug: string;
}

export interface EmailDraft {
  id: string;
  type: EmailDraftType;
  sequence_id: string | null;
  sequence_step: number | null;
  subject: string;
  subject_alt: string | null;
  preheader: string | null;
  body: string;
  body_format: 'plain' | 'html' | 'markdown';
  from_name: string;
  from_email: string;
  reply_to: string | null;
  delivery_system: 'listmonk' | 'resend' | 'smtp';
  delivery_config: Record<string, unknown>;
  recipients: EmailRecipient[] | null;
  cc: EmailRecipient[] | null;
  bcc: EmailRecipient[] | null;
  personalization_fields: string[] | null;
  status: EmailDraftStatus;
  scheduled_for: string | null;
  reviewable_after: string | null;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  sent_at: string | null;
  send_result: Record<string, unknown> | null;
  error: string | null;
  slug: string | null;
  crm_person_id: string | null;
  crm_opportunity_id: string | null;
  reply_to_message_id: string | null;
  listmonk_campaign_id: number | null;
  listmonk_campaign_status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  sequence?: EmailDraftSequence | null;
}

const SELECT_COLUMNS = '*, sequence:email_sequences(name, slug)';

export function emailDraftsListQuery() {
  return queryOptions({
    queryKey: queryKeys.emailDrafts.list(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select(SELECT_COLUMNS)
        .neq('status', 'sent')
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as EmailDraft[];
    },
  });
}

export function emailDraftDetailQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.emailDrafts.detail(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select(SELECT_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as EmailDraft | null;
    },
  });
}

// Newsletter-specific list (type=newsletter or investor_update). Used by
// /outbox/newsletter sub-routes. Default returns drafts in any non-sent
// status; pass `statuses` to narrow.
export function newsletterDraftsListQuery(opts?: {
  statuses?: EmailDraftStatus[];
}) {
  const statuses = opts?.statuses ?? [
    'draft',
    'pending_review',
    'approved',
    'rejected',
  ];
  return queryOptions({
    queryKey: queryKeys.newsletters.list(statuses.join(',')),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select(SELECT_COLUMNS)
        .in('type', ['newsletter', 'investor_update'])
        .in('status', statuses)
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as EmailDraft[];
    },
  });
}
