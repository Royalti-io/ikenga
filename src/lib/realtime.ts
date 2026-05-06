import { useEffect } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

/**
 * Subscribe to Postgres changes on a table while the component is mounted.
 * Cleans up the channel on unmount.
 *
 * Pass an `onChange` callback that receives the raw payload — typically you'll
 * call `queryClient.invalidateQueries()` inside it.
 *
 * Example:
 *   useRealtimeChannel('tasks', () => queryClient.invalidateQueries(...))
 */
export function useRealtimeChannel(
  table: string,
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
  opts: { schema?: string; filter?: string } = {},
) {
  const { schema = 'public', filter } = opts;

  useEffect(() => {
    const channel = supabase
      .channel(`rt:${schema}:${table}${filter ? `:${filter}` : ''}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema,
          table,
          ...(filter ? { filter } : {}),
        },
        onChange as never,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [table, schema, filter, onChange]);
}
