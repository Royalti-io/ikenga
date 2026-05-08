import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { supabaseConfigGet } from '@/lib/tauri-cmd';

/**
 * Persistent banner shown when no Supabase project config exists.
 * Hidden once the user saves a URL + anon key in Settings → Supabase.
 */
export function SupabaseBanner() {
  const cfg = useQuery({
    queryKey: ['supabase', 'config'],
    queryFn: () => supabaseConfigGet(),
    staleTime: Infinity,
  });
  const navigate = useNavigate();

  if (cfg.data || cfg.isLoading) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          Supabase project not configured — Tasks, Mail, Finance and other DB-backed views won't load
          data until you set the project URL and anon key.
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-6 border-amber-300 bg-white text-xs dark:bg-transparent"
        onClick={() => navigate({ to: '/settings' })}
      >
        Open Settings
      </Button>
    </div>
  );
}
