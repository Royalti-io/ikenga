import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export type SocialQueueStatus =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'posted'
  | 'failed';

export interface SocialQueueItem {
  id: string;
  platform: string;
  account: string;
  content: string;
  media_path: string | null;
  status: SocialQueueStatus;
  scheduled_for: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  posted_at: string | null;
  source: 'manual' | 'blog-pipeline' | 'cmo-cycle';
  error: string | null;
  proof_path: string | null;
  post_url: string | null;
  slug: string | null;
}

export function socialQueueListQuery() {
  return queryOptions({
    queryKey: queryKeys.socialQueue.list(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('social_queue')
        .select('*')
        .neq('status', 'posted')
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SocialQueueItem[];
    },
  });
}

export function socialQueueDraftsQuery() {
  return queryOptions({
    queryKey: queryKeys.socialQueue.list('draft'),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('social_queue')
        .select('*')
        .eq('status', 'draft')
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SocialQueueItem[];
    },
  });
}

export function socialQueueDetailQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.socialQueue.detail(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('social_queue')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data as SocialQueueItem | null;
    },
  });
}
